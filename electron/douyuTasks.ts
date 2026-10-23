import { randomUUID } from 'node:crypto'
import { DOUYU_TASK_KINDS, DOUYU_TASK_POLICIES } from '../server/douyu/types'
import type {
  CreateDouyuTask, DouyuMessageInput, DouyuMessageOutcome, DouyuRuntimeState, DouyuTaskDefinition, DouyuTaskOutcome,
  DouyuTaskKind, DouyuTaskPolicy, DouyuTaskStorage, DouyuTasksSnapshot, DouyuTaskView,
} from '../server/douyu/types'

export type DouyuTaskErrorCode = 'invalid-arguments' | 'task-not-found' | 'task-limit'
  | 'task-exists' | 'storage-failed' | 'disposed'

export class DouyuTaskError extends Error {
  constructor(readonly code: DouyuTaskErrorCode, message?: string) {
    super(message ?? {
      'invalid-arguments': '任务参数无效',
      'task-not-found': '未找到该任务',
      'task-limit': '任务数量已达到上限',
      'task-exists': '该账号在此房间已有相同任务',
      'storage-failed': '任务配置读取或保存失败, 请检查本地配置',
      disposed: '任务服务已关闭',
    }[code])
    this.name = 'DouyuTaskError'
  }
}

export interface DouyuTaskManagerOptions {
  load: () => unknown
  save: (data: DouyuTaskStorage) => void
  run: (task: DouyuTaskDefinition, signal: AbortSignal) => Promise<DouyuTaskOutcome>
  sendMessage?: (input: DouyuMessageInput, signal: AbortSignal) => Promise<DouyuMessageOutcome>
  now?: () => number
  id?: () => string
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type TaskRecord = Omit<DouyuTaskView, keyof DouyuTaskDefinition> & { definition: DouyuTaskDefinition }
type FlightControl = { controller: AbortController; cancelled: boolean; dispatched: boolean }
type TaskFlight = FlightControl & { type: 'task'; task: TaskRecord }
type ImmediateMessage = FlightControl & {
  type: 'message'
  input: DouyuMessageInput
  resolve: ((outcome: DouyuMessageOutcome) => void) | null
}
type Flight = TaskFlight | ImmediateMessage
type Wakeup = { handle: unknown }
const LIMIT = 64
const MAX_TIMER_MS = 2_147_483_647
const DEFINITION_KEYS = ['id', 'accountId', 'room', 'kind', 'policy', 'repeatMinutes', 'createdAt']
const INPUT_KEYS = ['accountId', 'room', 'kind', 'policy', 'repeatMinutes']
const MESSAGE_INPUT_KEYS = ['accountId', 'room', 'text', 'color']
const FAILURE = '任务执行失败, 请检查登录状态后手动重试'
const MESSAGE_FAILURE = '弹幕发送失败, 请检查当前账号与房间后手动重试'
const UNSAFE_MESSAGE_TEXT = /[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u

/** Main owns the queue, lifecycle gates and cancellation of all account writes. */
export class DouyuTaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly listeners = new Set<(snapshot: DouyuTasksSnapshot) => void>()
  private retainedRooms = new Set<string>()
  private queue: string[] = []
  private activeAccountId: string | null = null
  private currentRoom: string | null = null
  private runtime: DouyuRuntimeState = { foreground: false, locked: false, suspended: false }
  private flight: Flight | null = null
  private immediate: ImmediateMessage | null = null
  private wakeup: Wakeup | null = null
  private disposed = false
  private readonly now: () => number
  private readonly newId: () => string
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: DouyuTaskManagerOptions) {
    this.now = options.now ?? Date.now
    this.newId = options.id ?? randomUUID
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    try {
      const raw = options.load()
      if (raw === undefined) return
      const data = readStorage(raw)
      this.retainedRooms = new Set(data.retainedRooms)
      for (const definition of data.tasks) this.tasks.set(definition.id, record(definition, '应用已重启, 请手动启动'))
    } catch { throw new DouyuTaskError('storage-failed') }
  }

  snapshot(): DouyuTasksSnapshot {
    return {
      activeAccountId: this.activeAccountId, currentRoom: this.currentRoom,
      retainedRooms: [...this.retainedRooms], runtime: { ...this.runtime },
      tasks: [...this.tasks.values()].map(task => ({
        ...task.definition, status: task.status, reason: task.reason,
        lastRunAt: task.lastRunAt, nextRunAt: task.nextRunAt, lastResult: task.lastResult,
      })),
    }
  }

  subscribe(listener: (snapshot: DouyuTasksSnapshot) => void): () => void {
    if (!this.disposed) this.listeners.add(listener)
    this.notify(listener)
    return () => { this.listeners.delete(listener) }
  }

  async sendMessage(raw: DouyuMessageInput): Promise<DouyuMessageOutcome> {
    this.ensureAlive()
    const input = readMessageInput(raw)
    if (this.immediate) return failedMessage('已有一条手动弹幕正在发送或等待, 请等待当前请求结束')
    if (!this.messageAllowed(input)) return failedMessage('手动弹幕仅允许在当前账号和房间处于前台且未锁屏或休眠时发送')
    if (typeof this.options.sendMessage !== 'function') return failedMessage()
    return new Promise(resolve => {
      this.immediate = { type: 'message', input, resolve, controller: new AbortController(), cancelled: false, dispatched: false }
      this.refresh()
    })
  }

  create(input: CreateDouyuTask): DouyuTasksSnapshot {
    this.ensureAlive()
    const values = readInput(input)
    if ([...this.tasks.values()].some(task => sameWork(task.definition, values))) throw new DouyuTaskError('task-exists')
    if (this.tasks.size >= LIMIT) throw new DouyuTaskError('task-limit')
    const definition = readDefinition({ ...values, id: this.newId(), createdAt: this.now() })
    if (this.tasks.has(definition.id)) throw new DouyuTaskError('task-exists')
    this.persist([...this.definitions(), definition])
    this.tasks.set(definition.id, record(definition, '尚未启动'))
    this.publish()
    return this.snapshot()
  }

  setPolicy(id: string, policy: DouyuTaskPolicy): DouyuTasksSnapshot {
    const task = this.task(id)
    const nextPolicy = readPolicy(policy)
    if (task.definition.policy === nextPolicy) return this.snapshot()
    const definition = { ...task.definition, policy: nextPolicy }
    this.persist(this.definitions().map(item => item.id === definition.id ? definition : item))
    task.definition = definition
    this.refresh()
    return this.snapshot()
  }

  start(id: string): DouyuTasksSnapshot {
    const task = this.task(id)
    // Repeated clicks must neither duplicate a write nor bypass a recurring deadline.
    if (task.status === 'running' || task.status === 'queued') return this.snapshot()
    task.status = 'queued'
    task.reason = null
    task.nextRunAt = null
    this.queue.push(task.definition.id)
    this.refresh()
    return this.snapshot()
  }

  pause(id: string, reason?: string): DouyuTasksSnapshot {
    const task = this.task(id)
    this.stop(task, 'paused', readReason(reason, '已暂停, 请手动启动'))
    this.refresh()
    return this.snapshot()
  }

  remove(id: string): DouyuTasksSnapshot {
    const task = this.task(id)
    this.stopBeforeSave([task], '任务已停止')
    this.persistAfterStop(this.definitions().filter(item => item.id !== task.definition.id), this.retainedRooms, [task])
    this.tasks.delete(task.definition.id)
    this.refresh()
    return this.snapshot()
  }

  setActiveAccount(id: string | null): void {
    if (this.disposed) return
    const next = id === null ? null : readId(id)
    if (next === this.activeAccountId) return
    const previous = this.activeAccountId
    this.activeAccountId = next
    if (previous !== null) this.pauseMatching(previous, '已切换账号, 请手动启动')
    this.refresh()
  }

  pauseAccount(id: string, reason?: string): void {
    this.ensureAlive()
    this.pauseMatching(readId(id), readReason(reason, '账号任务已暂停, 请手动启动'))
    this.refresh()
  }

  removeAccount(id: string): void {
    this.ensureAlive()
    const accountId = readId(id)
    const affected = [...this.tasks.values()].filter(task => task.definition.accountId === accountId)
    const remaining = this.definitions().filter(task => task.accountId !== accountId)
    if (this.immediate?.input.accountId === accountId) this.cancelMessage()
    this.stopBeforeSave(affected, '账号任务已停止')
    if (affected.length) this.persistAfterStop(remaining, this.retainedRooms, affected)
    for (const task of affected) this.tasks.delete(task.definition.id)
    if (this.activeAccountId === accountId) this.activeAccountId = null
    this.refresh()
  }

  setRoom(room: string | null): void {
    if (this.disposed) return
    const next = room === null ? null : readRoom(room)
    if (next === this.currentRoom) return
    const previous = this.currentRoom
    this.currentRoom = next
    this.cancelMessage()
    if (previous !== null && !this.retainedRooms.has(previous)) this.stopRoom(previous, '已离开房间, 请手动启动', true)
    this.refresh()
  }

  retainRoom(room: string, retain: boolean): DouyuTasksSnapshot {
    this.ensureAlive()
    const target = readRoom(room)
    if (typeof retain !== 'boolean') throw new DouyuTaskError('invalid-arguments')
    if (this.retainedRooms.has(target) === retain) return this.snapshot()
    const next = new Set(this.retainedRooms)
    if (retain) {
      if (next.size >= LIMIT) throw new DouyuTaskError('task-limit')
      next.add(target)
    } else next.delete(target)
    if (!retain && this.currentRoom !== target) {
      const affected = [...this.tasks.values()].filter(task => task.definition.room === target)
      this.stopBeforeSave(affected, '房间任务已停止, 请手动启动')
      this.persistAfterStop(this.definitions(), next, affected)
    } else this.persist(this.definitions(), next)
    this.retainedRooms = next
    this.refresh()
    return this.snapshot()
  }

  closeRoom(room: string): DouyuTasksSnapshot {
    this.ensureAlive()
    const target = readRoom(room)
    const affected = [...this.tasks.values()].filter(task => task.definition.room === target)
    if (this.immediate?.input.room === target) this.cancelMessage()
    this.stopBeforeSave(affected, '房间任务已停止, 请手动启动')
    if (this.retainedRooms.has(target)) {
      const next = new Set(this.retainedRooms)
      next.delete(target)
      this.persistAfterStop(this.definitions(), next, affected)
      this.retainedRooms = next
    }
    if (this.currentRoom === target) this.currentRoom = null
    this.refresh()
    return this.snapshot()
  }

  setRuntime(state: DouyuRuntimeState): void {
    if (this.disposed) return
    const fields = dataFields(state, ['foreground', 'locked', 'suspended'])
    if (!fields || typeof fields.foreground !== 'boolean' || typeof fields.locked !== 'boolean'
      || typeof fields.suspended !== 'boolean') throw new DouyuTaskError('invalid-arguments')
    this.runtime = { foreground: fields.foreground, locked: fields.locked, suspended: fields.suspended }
    this.refresh()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWakeup()
    this.cancelMessage()
    for (const task of this.tasks.values()) this.stop(task, 'stopped', '应用已退出, 任务已停止')
    this.publish()
    this.listeners.clear()
  }

  private definitions(): DouyuTaskDefinition[] {
    return [...this.tasks.values()].map(task => ({ ...task.definition }))
  }

  private persist(tasks: DouyuTaskDefinition[], rooms = this.retainedRooms): void {
    // Definition changes and new work only commit after this synchronous save succeeds.
    try { this.options.save({ version: 1, tasks: tasks.map(task => ({ ...task })), retainedRooms: [...rooms] }) }
    catch { throw new DouyuTaskError('storage-failed') }
  }

  private stopBeforeSave(tasks: TaskRecord[], reason: string): void {
    // A failed configuration save must never undo an explicit stop request.
    for (const task of tasks) this.stop(task, 'stopped', reason)
    this.clearWakeup()
    if (this.flight) return
    const deadlines = this.queue.flatMap(id => {
      const task = this.tasks.get(id)
      return task?.status === 'queued' && task.nextRunAt !== null && this.gate(task) === null ? [task.nextRunAt] : []
    })
    // Preserve other rooms' existing deadlines without pumping or arming new work.
    if (deadlines.length) this.schedule(Math.min(...deadlines), this.now())
  }

  private persistAfterStop(tasks: DouyuTaskDefinition[], rooms: Set<string>, stopped: TaskRecord[]): void {
    try { this.persist(tasks, rooms) }
    catch {
      for (const task of stopped) task.reason = `${task.reason}. 配置修改未保存`
      this.publish()
      throw new DouyuTaskError('storage-failed', stopped.length
        ? '相关任务已停止, 配置修改未保存, 请重试保存'
        : '配置修改未保存, 请重试保存')
    }
  }

  private ensureAlive(): void {
    if (this.disposed) throw new DouyuTaskError('disposed')
  }

  private task(id: string): TaskRecord {
    this.ensureAlive()
    const found = this.tasks.get(readId(id))
    if (!found) throw new DouyuTaskError('task-not-found')
    return found
  }

  private pauseMatching(accountId: string, reason: string): void {
    if (this.immediate?.input.accountId === accountId) this.cancelMessage()
    for (const task of this.tasks.values()) {
      if (task.definition.accountId === accountId && armed(task)) this.stop(task, 'paused', reason)
    }
  }

  private stopRoom(room: string, reason: string, onlyArmed: boolean): void {
    for (const task of this.tasks.values()) {
      if (task.definition.room === room && (!onlyArmed || armed(task))) this.stop(task, 'stopped', reason)
    }
  }

  private stop(task: TaskRecord, status: 'paused' | 'stopped', reason: string): void {
    const flight = this.flight?.type === 'task' && this.flight.task === task && !this.flight.cancelled ? this.flight : null
    task.status = status
    task.reason = flight?.dispatched ? `${reason}. 请求可能已处理, 请确认结果后手动启动` : reason
    task.nextRunAt = null
    this.queue = this.queue.filter(id => id !== task.definition.id)
    if (flight) {
      flight.cancelled = true
      flight.controller.abort()
    }
  }

  private gate(task: TaskRecord): string | null {
    if (task.definition.accountId !== this.activeAccountId) return '等待切换到该账号'
    if (task.definition.room !== this.currentRoom && !this.retainedRooms.has(task.definition.room)) return '等待进入或保留该房间'
    if (this.runtime.suspended) return '系统休眠中, 等待恢复'
    if (this.runtime.locked && task.definition.policy !== 'background-locked') return '系统已锁屏, 等待解锁'
    if (!this.runtime.foreground && task.definition.policy === 'foreground') return '等待应用回到前台'
    return null
  }

  private messageAllowed(input: DouyuMessageInput): boolean {
    return input.accountId === this.activeAccountId && input.room === this.currentRoom
      && this.runtime.foreground && !this.runtime.locked && !this.runtime.suspended
  }

  private messageMayDispatch(message: ImmediateMessage): boolean {
    return this.flight === message && this.immediate === message && !message.cancelled && !this.disposed
      && !message.controller.signal.aborted && this.messageAllowed(message.input)
  }

  private resolveMessage(message: ImmediateMessage, outcome: DouyuMessageOutcome): void {
    const resolve = message.resolve
    message.resolve = null
    resolve?.(outcome)
  }

  private cancelMessage(message: ImmediateMessage | null = this.immediate): void {
    if (!message || message.cancelled) return
    message.cancelled = true
    this.resolveMessage(message, message.dispatched
      ? { status: 'waiting-user', message: '发送已取消, 请求可能已处理, 请核对结果后再手动发送', nextAllowedAt: null }
      : failedMessage('手动发送已取消, 未发送弹幕'))
    message.controller.abort()
    // A dispatched request keeps both the input limit and the execution lane until it settles.
    if (this.flight !== message && this.immediate === message) this.immediate = null
  }

  private refresh(): void {
    if (this.disposed) return
    this.clearWakeup()
    if (this.immediate && !this.messageAllowed(this.immediate.input)) this.cancelMessage()
    if (this.flight?.type === 'task' && !this.flight.cancelled) {
      const reason = this.gate(this.flight.task)
      if (reason) this.stop(this.flight.task, 'paused', reason)
    }
    const now = this.now()
    let nextAt: number | null = null
    let nextFlight: Flight | null = null
    if (!this.flight && this.immediate && !this.immediate.cancelled) {
      nextFlight = this.immediate
      this.flight = nextFlight
    }
    for (const id of [...this.queue]) {
      const task = this.tasks.get(id)
      if (!task || task.status !== 'queued') continue
      const blocked = this.gate(task)
      const future = task.nextRunAt !== null && task.nextRunAt > now
      task.reason = blocked ?? (future ? '等待下次执行时间' : this.flight ? '等待前一个请求结束' : null)
      if (blocked) continue
      if (future) {
        nextAt = nextAt === null ? task.nextRunAt : Math.min(nextAt, task.nextRunAt!)
        continue
      }
      if (this.flight) continue
      nextFlight = { type: 'task', task, controller: new AbortController(), cancelled: false, dispatched: false }
      this.flight = nextFlight
      task.status = 'running'
      task.reason = null
      task.nextRunAt = null
      this.queue = this.queue.filter(queuedId => queuedId !== id)
    }
    if (nextAt !== null && !this.flight) this.schedule(nextAt, now)
    this.publish()
    if (nextFlight) this.dispatch(nextFlight)
  }

  private dispatch(flight: Flight): void {
    if (flight.type === 'message') { this.dispatchMessage(flight); return }
    // A microtask lets synchronous lifecycle events cancel before any network dispatch.
    void Promise.resolve().then(() => {
      if (flight.cancelled || this.disposed) return null
      flight.dispatched = true
      flight.task.lastRunAt = this.now()
      this.publish()
      // An observer can synchronously trigger a lifecycle change during publication.
      if (flight.cancelled || this.disposed) return null
      return this.options.run({ ...flight.task.definition }, flight.controller.signal)
    }).then(outcome => this.finish(flight, outcome), () => this.finish(flight, { status: 'failed', message: FAILURE }))
  }

  private finish(flight: TaskFlight, outcome: DouyuTaskOutcome | null): void {
    if (this.flight !== flight) return
    this.flight = null
    if (this.disposed) return
    // Keep the lane occupied until even an aborted request settles. Its result is stale.
    if (!flight.cancelled && this.tasks.get(flight.task.definition.id) === flight.task) {
      const task = flight.task
      const result = readOutcome(outcome)
      task.status = result.status
      task.reason = result.status === 'succeeded' ? null : result.message
      task.lastResult = result.message
      task.nextRunAt = null
      if (result.status === 'succeeded' && task.definition.repeatMinutes !== null) {
        task.status = 'queued'
        task.nextRunAt = this.now() + task.definition.repeatMinutes * 60_000
        this.queue.push(task.definition.id)
      }
    }
    this.refresh()
  }

  private dispatchMessage(message: ImmediateMessage): void {
    void Promise.resolve().then(() => {
      if (!this.messageMayDispatch(message)) { this.cancelMessage(message); return null }
      this.publish()
      // Publication can synchronously switch accounts, close a room or stop all writes.
      if (!this.messageMayDispatch(message)) { this.cancelMessage(message); return null }
      const send = this.options.sendMessage
      if (typeof send !== 'function') return null
      message.dispatched = true
      return send({ ...message.input }, message.controller.signal)
    }).then(outcome => this.finishMessage(message, outcome), () => this.finishMessage(message, null))
  }

  private finishMessage(message: ImmediateMessage, outcome: unknown): void {
    if (this.flight !== message) return
    if (!message.cancelled) {
      const result = readMessageOutcome(outcome)
      if (!this.messageMayDispatch(message)) this.cancelMessage(message)
      else this.resolveMessage(message, result)
    }
    // Cancellation may have already resolved the caller, but never frees a live network request.
    this.flight = null
    if (this.immediate === message) this.immediate = null
    this.refresh()
  }

  private schedule(at: number, now: number): void {
    const wakeup: Wakeup = { handle: undefined }
    this.wakeup = wakeup
    wakeup.handle = this.setTimer(() => {
      if (this.wakeup !== wakeup || this.disposed) return
      this.wakeup = null
      this.refresh()
    }, Math.min(MAX_TIMER_MS, Math.max(1, at - now)))
  }

  private clearWakeup(): void {
    const wakeup = this.wakeup
    this.wakeup = null
    if (wakeup) this.clearTimer(wakeup.handle)
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener)
  }

  private notify(listener: (snapshot: DouyuTasksSnapshot) => void): void {
    try { listener(this.snapshot()) } catch { /* Observers cannot disrupt the execution lane. */ }
  }
}

function record(definition: DouyuTaskDefinition, reason: string): TaskRecord {
  return { definition, status: 'paused', reason, lastRunAt: null, nextRunAt: null, lastResult: null }
}

function armed(task: TaskRecord): boolean { return task.status === 'queued' || task.status === 'running' }
function sameWork(left: CreateDouyuTask, right: CreateDouyuTask): boolean {
  return left.accountId === right.accountId && left.room === right.room && left.kind === right.kind
}

/** Read only plain data fields, never persisted accessors, prototypes or extra settings. */
function dataFields(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const prototype: unknown = Object.getPrototypeOf(raw)
    if (prototype !== Object.prototype && prototype !== null) return null
    if (Reflect.ownKeys(raw).length !== keys.length) return null
    const fields: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)
      if (!descriptor || !('value' in descriptor)) return null
      fields[key] = descriptor.value
    }
    return fields
  } catch { return null }
}

function readId(raw: unknown): string {
  if (typeof raw !== 'string' || (raw !== 'default' && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(raw))) {
    throw new DouyuTaskError('invalid-arguments')
  }
  return raw.toLowerCase()
}

function readRoom(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,11}$/.test(raw)) throw new DouyuTaskError('invalid-arguments')
  return raw
}

function readPolicy(raw: unknown): DouyuTaskPolicy {
  if (!DOUYU_TASK_POLICIES.includes(raw as DouyuTaskPolicy)) throw new DouyuTaskError('invalid-arguments')
  return raw as DouyuTaskPolicy
}

function readInput(raw: unknown): CreateDouyuTask {
  const fields = dataFields(raw, INPUT_KEYS)
  if (!fields || !DOUYU_TASK_KINDS.includes(fields.kind as DouyuTaskKind) || (fields.repeatMinutes !== null
    && (typeof fields.repeatMinutes !== 'number' || !Number.isInteger(fields.repeatMinutes)
      || fields.repeatMinutes < 60 || fields.repeatMinutes > 43_200))) throw new DouyuTaskError('invalid-arguments')
  return { accountId: readId(fields.accountId), room: readRoom(fields.room), kind: fields.kind as DouyuTaskKind,
    policy: readPolicy(fields.policy), repeatMinutes: fields.repeatMinutes as number | null }
}

function readMessageInput(raw: unknown): DouyuMessageInput {
  const fields = dataFields(raw, MESSAGE_INPUT_KEYS)
  if (!fields || typeof fields.text !== 'string' || !fields.text.trim() || fields.text.length > 500
    || UNSAFE_MESSAGE_TEXT.test(fields.text) || typeof fields.color !== 'number' || !Number.isInteger(fields.color)
    || fields.color < 0 || fields.color > 6) throw new DouyuTaskError('invalid-arguments')
  return { accountId: readId(fields.accountId), room: readRoom(fields.room), text: fields.text, color: fields.color }
}

function readDefinition(raw: unknown): DouyuTaskDefinition {
  const fields = dataFields(raw, DEFINITION_KEYS)
  if (!fields || typeof fields.createdAt !== 'number' || !Number.isSafeInteger(fields.createdAt)
    || fields.createdAt < 0) throw new DouyuTaskError('invalid-arguments')
  return { ...readInput({ accountId: fields.accountId, room: fields.room, kind: fields.kind,
    policy: fields.policy, repeatMinutes: fields.repeatMinutes }), id: readId(fields.id), createdAt: fields.createdAt }
}

function readStorage(raw: unknown): DouyuTaskStorage {
  const fields = dataFields(raw, ['version', 'tasks', 'retainedRooms'])
  const taskData = dataItems(fields?.tasks)
  const roomData = dataItems(fields?.retainedRooms)
  if (!fields || fields.version !== 1 || !taskData || !roomData) throw new DouyuTaskError('storage-failed')
  const tasks = taskData.map(readDefinition)
  const retainedRooms = roomData.map(readRoom)
  if (new Set(tasks.map(task => task.id)).size !== tasks.length
    || new Set(tasks.map(task => `${task.accountId}:${task.room}:${task.kind}`)).size !== tasks.length
    || new Set(retainedRooms).size !== retainedRooms.length) throw new DouyuTaskError('storage-failed')
  return { version: 1, tasks, retainedRooms }
}

function dataItems(raw: unknown): unknown[] | null {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null
    const length = Object.getOwnPropertyDescriptor(raw, 'length')?.value as unknown
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > LIMIT
      || Reflect.ownKeys(raw).length !== length + 1) return null
    const items: unknown[] = []
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
      if (!descriptor || !('value' in descriptor)) return null
      items.push(descriptor.value)
    }
    return items
  } catch { return null }
}

function readReason(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 160 || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new DouyuTaskError('invalid-arguments')
  }
  return raw.trim()
}

function readOutcome(raw: unknown): DouyuTaskOutcome {
  const fields = dataFields(raw, ['status', 'message'])
  if (!fields || !['succeeded', 'waiting-user', 'failed'].includes(fields.status as string)
    || typeof fields.message !== 'string' || !fields.message.trim() || fields.message.length > 240
    || /[\x00-\x1f\x7f]/.test(fields.message)) return { status: 'failed', message: FAILURE }
  return { status: fields.status as DouyuTaskOutcome['status'], message: fields.message.trim() }
}

function failedMessage(message = MESSAGE_FAILURE): DouyuMessageOutcome {
  return { status: 'failed', message, nextAllowedAt: null }
}

function readMessageOutcome(raw: unknown): DouyuMessageOutcome {
  const fields = dataFields(raw, ['status', 'message', 'nextAllowedAt'])
  if (!fields || !['succeeded', 'waiting-user', 'failed'].includes(fields.status as string)
    || typeof fields.message !== 'string' || !fields.message.trim() || fields.message.length > 240
    || UNSAFE_MESSAGE_TEXT.test(fields.message) || (fields.nextAllowedAt !== null
      && (typeof fields.nextAllowedAt !== 'number' || !Number.isSafeInteger(fields.nextAllowedAt)
        || fields.nextAllowedAt < 0 || fields.nextAllowedAt > 8_640_000_000_000_000))) return failedMessage()
  return { status: fields.status as DouyuMessageOutcome['status'], message: fields.message.trim(), nextAllowedAt: fields.nextAllowedAt as number | null }
}
