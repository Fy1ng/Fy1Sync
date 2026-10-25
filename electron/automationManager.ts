import { randomUUID } from 'node:crypto'
import type { DouyuTaskManager } from './douyuTasks'
import { DOUYU_TASK_POLICIES, type DouyuTaskPolicy, type DouyuTasksSnapshot } from '../server/douyu/types'
import { readAutomationRequest, type DouyuAutomationRequest, type DouyuAutomationOutcome, type DouyuAutomationProgress } from '../server/douyu/automationTypes'

export interface AutomationDefinition extends Omit<DouyuAutomationRequest, 'taskId'> {
  id: string
  createdAt: number
  policy: DouyuTaskPolicy
  repeatMinutes: number | null
}
export type CreateAutomation = Omit<AutomationDefinition, 'id' | 'createdAt'>
export interface AutomationView extends AutomationDefinition {
  status: 'paused' | 'queued' | 'running' | 'succeeded' | 'waiting-user' | 'failed'
  reason: string | null
  nextRunAt: number | null
  lastRunAt: number | null
  progress: DouyuAutomationProgress | null
}
export interface AutomationStorage { version: 1; tasks: AutomationDefinition[] }
export interface AutomationSnapshot { tasks: AutomationView[] }
export class AutomationError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'task-not-found' | 'task-limit' | 'storage-failed' | 'disposed') {
    super({ 'invalid-arguments': '批量任务参数无效', 'task-not-found': '批量任务不存在', 'task-limit': '批量任务已达到上限',
      'storage-failed': '批量任务配置保存或读取失败', disposed: '批量任务服务已关闭' }[code])
  }
}
type Flight = { id: string; controller: AbortController; dispatched: boolean }

/** Account/group/batch scheduling uses the existing single account-write lane. */
export class AutomationManager {
  private readonly tasks = new Map<string, AutomationView>()
  private readonly listeners = new Set<(snapshot: AutomationSnapshot) => void>()
  private readonly now: () => number
  private readonly id: () => string
  private readonly release: () => void
  private runtime: DouyuTasksSnapshot
  private flight: Flight | null = null
  private wake: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  constructor(private readonly deps: {
    queue: DouyuTaskManager
    load: () => unknown
    save: (value: AutomationStorage) => void
    run: (request: DouyuAutomationRequest, signal: AbortSignal) => Promise<DouyuAutomationOutcome>
    forget?: (id: string) => void
    now?: () => number
    id?: () => string
  }) {
    this.now = deps.now ?? Date.now
    this.id = deps.id ?? randomUUID
    this.runtime = deps.queue.snapshot()
    try {
      const raw = deps.load()
      if (raw !== undefined) {
        const value = raw as AutomationStorage
        if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'tasks,version'
          || !Array.isArray(value.tasks) || value.tasks.length > 128) throw new Error()
        for (const item of value.tasks) {
          const definition = readDefinition(item)
          if (this.tasks.has(definition.id)) throw new Error()
          this.tasks.set(definition.id, this.view(definition, '应用已重启, 请手动启动'))
        }
      }
    } catch { throw new AutomationError('storage-failed') }
    this.release = deps.queue.subscribe(snapshot => {
      const previous = this.runtime
      const changed = JSON.stringify([previous.activeAccountId, previous.currentRoom, previous.retainedRooms, previous.runtime])
        !== JSON.stringify([snapshot.activeAccountId, snapshot.currentRoom, snapshot.retainedRooms, snapshot.runtime])
      this.runtime = snapshot
      if (!changed) return
      if (previous.activeAccountId && previous.activeAccountId !== snapshot.activeAccountId) this.invalidateAccount(previous.activeAccountId)
      if (this.flight) {
        const task = this.tasks.get(this.flight.id)
        if (task && this.gate(task)) this.pause(task.id, '运行条件已变化, 请手动恢复')
      }
      this.pump()
    })
  }
  snapshot(): AutomationSnapshot { return { tasks: structuredClone([...this.tasks.values()]) } }
  subscribe(listener: (value: AutomationSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot()); return () => { this.listeners.delete(listener) }
  }
  create(input: CreateAutomation): AutomationSnapshot {
    this.alive()
    if (this.tasks.size >= 128) throw new AutomationError('task-limit')
    const definition = readDefinition({ ...input, id: this.id(), createdAt: this.now() })
    if (this.tasks.has(definition.id)) throw new AutomationError('invalid-arguments')
    this.persist([...this.definitions(), definition])
    this.tasks.set(definition.id, this.view(definition, '尚未启动'))
    this.publish(); return this.snapshot()
  }
  start(id: string): AutomationSnapshot {
    const task = this.require(id)
    if (task.status === 'running' || task.status === 'queued') return this.snapshot()
    this.deps.forget?.(id)
    task.status = 'queued'; task.reason = null; task.nextRunAt = null; task.progress = null
    this.pump(); return this.snapshot()
  }
  pause(id: string, reason = '已暂停, 请手动启动'): AutomationSnapshot {
    const task = this.require(id)
    task.status = 'paused'; task.nextRunAt = null
    task.reason = this.flight?.id === id && this.flight.dispatched ? reason + '. 已提交请求可能已处理, 请核对结果' : reason
    if (this.flight?.id === id) this.flight.controller.abort()
    this.publish(); this.pump(); return this.snapshot()
  }
  remove(id: string): AutomationSnapshot {
    this.pause(id, '任务已停止')
    this.persist(this.definitions().filter(task => task.id !== id))
    this.tasks.delete(id); this.deps.forget?.(id)
    this.publish(); this.pump(); return this.snapshot()
  }
  invalidateAccount(accountId: string): void {
    for (const task of this.tasks.values()) if (task.accountId === accountId && ['running', 'queued'].includes(task.status)) {
      task.status = 'paused'; task.reason = '账号已变化, 请核对结果后手动启动'; task.nextRunAt = null
      if (this.flight?.id === task.id) this.flight.controller.abort()
    }
    this.publish()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.release()
    if (this.wake) clearTimeout(this.wake)
    this.wake = null; this.flight?.controller.abort()
    this.listeners.clear()
  }
  private pump(): void {
    if (this.disposed) return
    if (this.wake) clearTimeout(this.wake)
    this.wake = null
    if (this.flight) return
    const now = this.now()
    let due = Infinity
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued') continue
      task.reason = this.gate(task)
      if (task.reason) continue
      if (task.nextRunAt !== null && task.nextRunAt > now) { due = Math.min(due, task.nextRunAt); continue }
      this.dispatch(task); return
    }
    if (Number.isFinite(due)) this.wake = setTimeout(() => this.pump(), Math.min(2_147_483_647, Math.max(1, due - now)))
    this.publish()
  }
  private dispatch(task: AutomationView): void {
    const flight: Flight = { id: task.id, controller: new AbortController(), dispatched: false }
    this.flight = flight; task.status = 'running'; task.reason = null; task.nextRunAt = null
    this.publish()
    const request: DouyuAutomationRequest = { taskId: task.id, accountId: task.accountId, kind: task.kind,
      target: structuredClone(task.target), options: structuredClone(task.options) }
    void this.deps.queue.runAccountOperation({ accountId: task.accountId, originRoom: null, rooms: task.target.type === 'room' ? [task.target.room] : [],
      scope: 'account', policy: task.policy }, async signal => {
      if (signal.aborted || flight.controller.signal.aborted || this.gate(task)) throw new Error('Operation no longer authorized')
      flight.dispatched = true; task.lastRunAt = this.now(); this.publish()
      return this.deps.run(request, signal)
    }, flight.controller.signal).then(outcome => {
      if (this.disposed || flight.controller.signal.aborted || this.tasks.get(task.id) !== task) return
      if (outcome.status === 'busy') { task.status = 'queued'; task.nextRunAt = this.now() + 1_000; task.reason = '等待前一个账号请求结束'; return }
      if (outcome.status !== 'completed') { task.status = 'waiting-user'; task.reason = '操作未确认完成, 请核对结果后手动恢复'; return }
      const result = readOutcome(outcome.value, this.now())
      task.progress = result.progress ? { ...result.progress } : null
      task.reason = result.status === 'succeeded' ? null : result.message
      if (result.status === 'scheduled') { task.status = 'queued'; task.nextRunAt = result.nextRunAt }
      else {
        task.status = result.status
        if (result.status === 'succeeded' && task.repeatMinutes !== null) {
          this.deps.forget?.(task.id)
          task.status = 'queued'; task.nextRunAt = this.now() + task.repeatMinutes * 60_000
        }
      }
    }).catch(() => {
      if (!flight.controller.signal.aborted && this.tasks.get(task.id) === task) { task.status = 'waiting-user'; task.reason = '操作结果不确定, 请核对后手动恢复' }
    }).finally(() => { if (this.flight === flight) this.flight = null; this.publish(); this.pump() })
  }
  private gate(task: AutomationDefinition): string | null {
    const state = this.runtime
    if (state.activeAccountId !== task.accountId) return '等待切换到该账号'
    if (task.target.type === 'room' && task.target.room !== state.currentRoom && !state.retainedRooms.includes(task.target.room)) return '等待进入或保留目标房间'
    if (state.runtime.suspended) return '等待系统恢复'
    if (state.runtime.locked && task.policy !== 'background-locked') return '等待解锁'
    if (!state.runtime.foreground && task.policy === 'foreground') return '等待应用前台运行'
    return null
  }
  private view(definition: AutomationDefinition, reason: string): AutomationView {
    return { ...definition, status: 'paused', reason, nextRunAt: null, lastRunAt: null, progress: null }
  }
  private definitions(): AutomationDefinition[] {
    return [...this.tasks.values()].map(task => ({ id: task.id, createdAt: task.createdAt, accountId: task.accountId,
      kind: task.kind, target: structuredClone(task.target), options: structuredClone(task.options), policy: task.policy, repeatMinutes: task.repeatMinutes }))
  }
  private require(id: string): AutomationView { this.alive(); const task = this.tasks.get(id); if (!task) throw new AutomationError('task-not-found'); return task }
  private alive(): void { if (this.disposed) throw new AutomationError('disposed') }
  private persist(tasks: AutomationDefinition[]): void { try { this.deps.save({ version: 1, tasks }) } catch { throw new AutomationError('storage-failed') } }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.snapshot()) } catch { /* Isolate observers. */ } } }
}

function readDefinition(raw: unknown): AutomationDefinition {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
    const value = raw as AutomationDefinition
    if (Object.keys(value).sort().join(',') !== 'accountId,createdAt,id,kind,options,policy,repeatMinutes,target'
      || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.id)
      || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !DOUYU_TASK_POLICIES.includes(value.policy)
      || (value.repeatMinutes !== null && (!Number.isSafeInteger(value.repeatMinutes) || value.repeatMinutes < 60 || value.repeatMinutes > 43_200))) throw new Error()
    const request = readAutomationRequest({ taskId: value.id, accountId: value.accountId, target: value.target, kind: value.kind, options: value.options })
    return { id: value.id, createdAt: value.createdAt, policy: value.policy, repeatMinutes: value.repeatMinutes,
      accountId: request.accountId, target: request.target, kind: request.kind, options: request.options }
  } catch { throw new AutomationError('invalid-arguments') }
}
function readOutcome(raw: DouyuAutomationOutcome, now: number): DouyuAutomationOutcome {
  if (!raw || !['succeeded', 'failed', 'waiting-user', 'scheduled'].includes(raw.status) || typeof raw.message !== 'string'
    || !raw.message || raw.message.length > 240 || /[\x00-\x1f\x7f]/.test(raw.message)) throw new Error('Invalid outcome')
  if (raw.status === 'scheduled' && (!Number.isSafeInteger(raw.nextRunAt) || raw.nextRunAt <= now || raw.nextRunAt > now + 86_400_000)) throw new Error('Invalid deadline')
  const p = raw.progress
  if (p && (!Number.isSafeInteger(p.completed) || p.completed < 0 || !Number.isSafeInteger(p.skipped) || p.skipped < 0
    || (p.total !== null && (!Number.isSafeInteger(p.total) || p.total < 0))
    || (p.current !== null && (typeof p.current !== 'string' || p.current.length > 128))
    || !['none', 'official-state', 'receipt-received', 'unconfirmed'].includes(p.evidence))) throw new Error('Invalid progress')
  return raw.status === 'scheduled' ? { ...raw, nextRunAt: Math.max(now + 5_000, raw.nextRunAt) } : raw
}
