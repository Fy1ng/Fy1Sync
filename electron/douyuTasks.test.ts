import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateDouyuTask, DouyuRuntimeState, DouyuTaskDefinition, DouyuTaskOutcome, DouyuTaskStorage,
} from '../server/douyu/types'
import { DouyuTaskError, DouyuTaskManager } from './douyuTasks'

const ACCOUNT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREGROUND: DouyuRuntimeState = { foreground: true, locked: false, suspended: false }
const BACKGROUND: DouyuRuntimeState = { foreground: false, locked: false, suspended: false }
const LOCKED: DouyuRuntimeState = { foreground: false, locked: true, suspended: false }
const SUSPENDED: DouyuRuntimeState = { foreground: false, locked: true, suspended: true }
const SUCCESS: DouyuTaskOutcome = { status: 'succeeded', message: '签到成功' }
const WAITING: DouyuTaskOutcome = { status: 'waiting-user', message: '请在官方页面完成验证' }
const FAILED: DouyuTaskOutcome = { status: 'failed', message: '签到未成功, 请手动重试' }
const INPUT: CreateDouyuTask = { accountId: 'default', room: '100', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }
const managers: DouyuTaskManager[] = []
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
const definition = (overrides: Partial<DouyuTaskDefinition> = {}): DouyuTaskDefinition => ({ ...INPUT, id: uuid(1), createdAt: 1_800_000_000_000, ...overrides })
const stored = (tasks = [definition()], retainedRooms: string[] = []): DouyuTaskStorage => ({ version: 1, tasks, retainedRooms })
const copy = <T>(value: T): T => structuredClone(value)

interface Attempt {
  task: DouyuTaskDefinition
  signal: AbortSignal
  resolve: (outcome: DouyuTaskOutcome) => void
  reject: (error: unknown) => void
}

function harness(initial: unknown = undefined, ready = true) {
  let saved: unknown = copy(initial)
  let serial = 0
  const attempts: Attempt[] = []
  const load = vi.fn(() => saved)
  const save = vi.fn((data: DouyuTaskStorage) => { saved = copy(data) })
  const run = vi.fn((task: DouyuTaskDefinition, signal: AbortSignal) => new Promise<DouyuTaskOutcome>((resolve, reject) => {
    attempts.push({ task, signal, resolve, reject })
  }))
  const manager = new DouyuTaskManager({ load, save, run, id: () => uuid(++serial) })
  managers.push(manager)
  if (ready) {
    manager.setActiveAccount('default')
    manager.setRoom('100')
    manager.setRuntime(FOREGROUND)
  }
  return { manager, attempts, load, save, run, saved: () => copy(saved) as DouyuTaskStorage }
}

function add(h: ReturnType<typeof harness>, overrides: Partial<CreateDouyuTask> = {}): string {
  return h.manager.create({ ...INPUT, ...overrides }).tasks.at(-1)!.id
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

function status(h: ReturnType<typeof harness>, id: string) { return h.manager.snapshot().tasks.find(task => task.id === id)! }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  vi.useRealTimers()
})

describe('Douyu main-process task definitions', () => {
  it('keeps room and Yuba check-ins independent and restores both paused', async () => {
    const h = harness()
    const room = add(h)
    const yuba = add(h, { kind: 'yuba-sign', repeatMinutes: 1440 })
    expect(() => add(h, { kind: 'yuba-sign' })).toThrow(expect.objectContaining({ code: 'task-exists' }))
    h.manager.start(yuba)
    await flush()
    expect(h.attempts[0]?.task.kind).toBe('yuba-sign')
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(status(h, yuba).nextRunAt).toBe(Date.now() + 86_400_000)
    expect(status(h, room)).toMatchObject({ status: 'paused', lastRunAt: null })
    const restored = harness(h.saved())
    expect(restored.manager.snapshot().tasks.map(task => ({ kind: task.kind, status: task.status, nextRunAt: task.nextRunAt })))
      .toEqual([{ kind: 'room-sign', status: 'paused', nextRunAt: null }, { kind: 'yuba-sign', status: 'paused', nextRunAt: null }])
    expect(restored.run).not.toHaveBeenCalled()
  })

  it('starts empty and creates paused definitions without persisting execution state', async () => {
    const h = harness(undefined, false)
    expect(h.manager.snapshot()).toEqual({ activeAccountId: null, currentRoom: null, retainedRooms: [], runtime: BACKGROUND, tasks: [] })
    expect(h.save).not.toHaveBeenCalled()
    const id = add(h)
    expect(status(h, id)).toMatchObject({ ...definition(), status: 'paused', nextRunAt: null, lastRunAt: null })
    expect(h.saved()).toEqual(stored())
    h.manager.setActiveAccount('default')
    h.manager.setRoom('100')
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(h.run).not.toHaveBeenCalled()
  })

  it.each([
    null, [], { ...INPUT, accountId: '../private' }, { ...INPUT, room: '0' }, { ...INPUT, room: '0100' },
    { ...INPUT, room: ' 100' }, { ...INPUT, room: '1234567890123' }, { ...INPUT, room: 100 },
    { ...INPUT, kind: 'send-message' }, { ...INPUT, policy: 'always' },
    { ...INPUT, repeatMinutes: undefined }, { ...INPUT, repeatMinutes: 59 }, { ...INPUT, repeatMinutes: 60.5 },
    { ...INPUT, repeatMinutes: 43_201 }, { ...INPUT, repeatMinutes: Infinity }, { ...INPUT, extra: true },
  ])('rejects malformed creation input before persistence or execution: %#', async input => {
    const h = harness()
    expect(() => h.manager.create(input as CreateDouyuTask)).toThrow(expect.objectContaining({ code: 'invalid-arguments' }))
    await flush()
    expect(h.save).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
  })

  it('deduplicates work across policies and normalizes UUIDs while allowing a different account', () => {
    const h = harness()
    add(h, { accountId: ACCOUNT_B.toUpperCase() })
    expect(() => add(h, { accountId: ACCOUNT_B, policy: 'background-locked', repeatMinutes: 60 }))
      .toThrow(expect.objectContaining({ code: 'task-exists' }))
    add(h)
    expect(h.manager.snapshot().tasks.map(task => task.accountId)).toEqual([ACCOUNT_B, 'default'])
  })

  it('caps task definitions at 64 without evicting an existing task', () => {
    const h = harness()
    for (let index = 1; index <= 64; index++) add(h, { room: String(index) })
    expect(() => add(h, { room: '65' })).toThrow(expect.objectContaining({ code: 'task-limit' }))
    expect(h.saved().tasks).toHaveLength(64)
    expect(h.manager.snapshot().tasks).toHaveLength(64)
  })

  it('restores every task paused and keeps retained rooms without restoring schedules', async () => {
    const h = harness(stored([definition({ id: 'default', repeatMinutes: 60 })], ['100']))
    expect(status(h, 'default')).toMatchObject({ status: 'paused', lastRunAt: null, nextRunAt: null, lastResult: null })
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    h.manager.start('default')
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it.each([
    null, [], {}, { version: 2, tasks: [], retainedRooms: [] },
    { ...stored(), extra: true }, stored([definition({ room: '01' })]),
    stored([{ ...definition(), status: 'running' } as DouyuTaskDefinition]),
    stored([definition({ repeatMinutes: 0 })]), stored([definition({ createdAt: -1 })]),
    stored([definition(), definition({ id: uuid(2) })]), stored([definition(), definition({ room: '200' })]),
    stored([], ['100', '100']), stored([], ['https://douyu.com/100']),
    stored([], new Array<string>(1)), stored(new Array<DouyuTaskDefinition>(1)),
    stored(Array.from({ length: 65 }, (_, index) => definition({ id: uuid(index), room: String(index + 1) }))),
  ])('fails visibly on corrupt or unsupported storage without overwriting it: %#', raw => {
    const save = vi.fn()
    expect(() => new DouyuTaskManager({ load: () => raw, save, run: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(save).not.toHaveBeenCalled()
  })

  it('does not evaluate accessors in persisted objects or disclose underlying load errors', () => {
    const getter = vi.fn(() => 1)
    const raw = Object.defineProperty({ tasks: [], retainedRooms: [] }, 'version', { enumerable: true, get: getter })
    expect(() => new DouyuTaskManager({ load: () => raw, save: vi.fn(), run: vi.fn() })).toThrow(DouyuTaskError)
    expect(getter).not.toHaveBeenCalled()
    expect(() => new DouyuTaskManager({ load: () => { throw new Error('COOKIE_PRIVATE') }, save: vi.fn(), run: vi.fn() }))
      .toThrow('任务配置读取或保存失败, 请检查本地配置')
    const roomGetter = vi.fn(() => '100')
    const rooms = Object.defineProperty(['100'], '0', { get: roomGetter })
    expect(() => new DouyuTaskManager({ load: () => stored([], rooms), save: vi.fn(), run: vi.fn() })).toThrow(DouyuTaskError)
    expect(roomGetter).not.toHaveBeenCalled()
  })

  it('isolates saved, returned and observer snapshots from mutable callers', async () => {
    const h = harness()
    const id = add(h)
    const seen: string[] = []
    h.manager.subscribe(snapshot => {
      snapshot.runtime.foreground = false
      snapshot.retainedRooms.push('999')
      snapshot.tasks[0]!.room = '999'
      throw new Error('observer failure')
    })
    const unsubscribe = h.manager.subscribe(snapshot => { seen.push(snapshot.tasks[0]!.room) })
    const returned = h.manager.start(id)
    returned.tasks[0]!.policy = 'background-locked'
    returned.tasks.length = 0
    await flush()
    h.attempts[0]!.task.accountId = ACCOUNT_B
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.manager.snapshot()).toMatchObject({ runtime: FOREGROUND, retainedRooms: [], tasks: [{ room: '100', accountId: 'default', policy: 'foreground' }] })
    expect(h.saved()).toEqual(stored())
    expect(seen.every(room => room === '100')).toBe(true)
    unsubscribe()
  })

  it('rejects invalid runtime, policies, ids and pause reasons without changing state', () => {
    const h = harness()
    const id = add(h)
    const before = h.manager.snapshot()
    for (const act of [
      () => h.manager.setPolicy(id, 'always' as never),
      () => h.manager.setRuntime({ ...FOREGROUND, locked: 1 } as never),
      () => h.manager.setRuntime({ ...FOREGROUND, additional: true } as never),
      () => h.manager.setRoom('01'), () => h.manager.setActiveAccount('unknown'),
      () => h.manager.pause(id, 'bad\nreason'), () => h.manager.retainRoom('100', 1 as never),
    ]) expect(act).toThrow(expect.objectContaining({ code: 'invalid-arguments' }))
    expect(() => h.manager.start(uuid(99))).toThrow(expect.objectContaining({ code: 'task-not-found' }))
    expect(h.manager.snapshot()).toEqual(before)
  })
})

describe('Douyu single execution lane and lifecycle', () => {
  it('executes eligible starts FIFO and ignores duplicate starts both running and queued', async () => {
    const h = harness()
    h.manager.retainRoom('200', true)
    const first = add(h)
    const second = add(h, { room: '200' })
    h.manager.start(second)
    h.manager.start(first)
    h.manager.start(first)
    h.manager.start(second)
    await flush()
    expect(h.attempts.map(attempt => attempt.task.id)).toEqual([second])
    expect(status(h, first)).toMatchObject({ status: 'queued', reason: '等待前一个请求结束' })
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.attempts.map(attempt => attempt.task.id)).toEqual([second, first])
    h.attempts[1]!.resolve(SUCCESS)
    await flush()
    expect(h.manager.snapshot().tasks.every(task => task.status === 'succeeded')).toBe(true)
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('keeps never-dispatched work queued until account, room and runtime all permit execution', async () => {
    const h = harness(undefined, false)
    const id = add(h)
    expect(h.manager.start(id).tasks[0]).toMatchObject({ status: 'queued', reason: '等待切换到该账号' })
    h.manager.setActiveAccount('default')
    expect(status(h, id).reason).toBe('等待进入或保留该房间')
    h.manager.setRoom('100')
    expect(status(h, id).reason).toBe('等待应用回到前台')
    h.manager.setRuntime(SUSPENDED)
    await flush()
    expect(h.run).not.toHaveBeenCalled()
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it.each([
    { policy: 'foreground' as const, permitted: FOREGROUND, blocked: BACKGROUND },
    { policy: 'background-unlocked' as const, permitted: BACKGROUND, blocked: LOCKED },
    { policy: 'background-locked' as const, permitted: LOCKED, blocked: SUSPENDED },
  ])('honors $policy and requires a fresh start after cancelling a dispatched request', async ({ policy, permitted, blocked }) => {
    const h = harness()
    h.manager.setRuntime(permitted)
    const id = add(h, { policy, repeatMinutes: 60 })
    h.manager.start(id)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.manager.setRuntime(blocked)
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    expect(status(h, id)).toMatchObject({ status: 'paused', nextRunAt: null })
    expect(status(h, id).reason).toContain('请求可能已处理')
    h.manager.setRuntime(permitted)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.manager.start(id)
    await flush()
    expect(status(h, id).status).toBe('queued')
    expect(h.run).toHaveBeenCalledOnce()
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(h.attempts[1]!.signal.aborted).toBe(false)
    expect(status(h, id)).toMatchObject({ status: 'running', lastResult: null, nextRunAt: null })
  })

  it('background-unlocked continues after focus loss and background-locked continues through lock', async () => {
    const h = harness()
    const id = add(h, { policy: 'background-unlocked' })
    h.manager.start(id)
    await flush()
    h.manager.setRuntime(BACKGROUND)
    expect(h.attempts[0]!.signal.aborted).toBe(false)
    h.manager.setPolicy(id, 'background-locked')
    h.manager.setRuntime(LOCKED)
    expect(h.attempts[0]!.signal.aborted).toBe(false)
    expect(status(h, id).status).toBe('running')
  })

  it('rechecks policy changes without restarting explicitly paused tasks', async () => {
    const h = harness()
    h.manager.setRuntime(BACKGROUND)
    const id = add(h)
    h.manager.start(id)
    await flush()
    expect(h.run).not.toHaveBeenCalled()
    h.manager.setPolicy(id, 'background-unlocked')
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.manager.setPolicy(id, 'foreground')
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    h.attempts[0]!.reject(new Error('aborted'))
    await flush()
    h.manager.setPolicy(id, 'background-locked')
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(status(h, id).status).toBe('paused')
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('does not dispatch when paused in the same turn as start', async () => {
    const h = harness()
    const id = add(h)
    h.manager.start(id)
    h.manager.pause(id)
    await flush()
    expect(h.run).not.toHaveBeenCalled()
    h.manager.setRuntime(BACKGROUND)
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(status(h, id).status).toBe('paused')
    expect(h.run).not.toHaveBeenCalled()
  })

  it('pauses old account work on switching and does not resume it on switching back', async () => {
    const h = harness()
    h.manager.retainRoom('200', true)
    const first = add(h)
    const queued = add(h, { room: '200' })
    const other = add(h, { accountId: ACCOUNT_B })
    h.manager.start(first)
    h.manager.start(queued)
    await flush()
    h.manager.setActiveAccount(ACCOUNT_B)
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    expect(status(h, first).status).toBe('paused')
    expect(status(h, queued).status).toBe('paused')
    h.manager.start(other)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.attempts[0]!.reject(new Error('old-account abort'))
    await flush()
    expect(h.attempts[1]!.task.accountId).toBe(ACCOUNT_B)
    h.attempts[1]!.resolve(SUCCESS)
    await flush()
    h.manager.setActiveAccount('default')
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(h.run).toHaveBeenCalledTimes(2)
    expect(status(h, first).status).toBe('paused')
    expect(status(h, queued).status).toBe('paused')
  })

  it('pauses an account explicitly without changing selected account or other account state', async () => {
    const h = harness()
    const first = add(h)
    const other = add(h, { accountId: ACCOUNT_B })
    h.manager.start(first)
    h.manager.start(other)
    await flush()
    h.manager.pauseAccount('default', '登录状态已变化')
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.manager.snapshot().activeAccountId).toBe('default')
    expect(status(h, first)).toMatchObject({ status: 'paused', lastResult: null })
    expect(status(h, other).status).toBe('queued')
    h.manager.setRuntime(FOREGROUND)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('stops old room work on a room change and does not revive it on returning', async () => {
    const h = harness()
    const id = add(h)
    h.manager.start(id)
    await flush()
    h.manager.setRoom('200')
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    expect(status(h, id).status).toBe('stopped')
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    h.manager.setRoom('100')
    await flush()
    expect(status(h, id)).toMatchObject({ status: 'stopped', lastResult: null })
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('keeps explicitly retained rooms running and closes only the named retained room', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const oldRoom = add(h)
    const newRoom = add(h, { room: '200' })
    h.manager.start(oldRoom)
    await flush()
    h.manager.setRoom('200')
    h.manager.start(newRoom)
    expect(h.attempts[0]!.signal.aborted).toBe(false)
    h.manager.closeRoom('100')
    expect(h.manager.snapshot()).toMatchObject({ currentRoom: '200', retainedRooms: [] })
    expect(status(h, oldRoom).status).toBe('stopped')
    expect(status(h, newRoom).status).toBe('queued')
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.attempts[1]!.task.id).toBe(newRoom)
    expect(h.saved().retainedRooms).toEqual([])
  })

  it('removing retention stops background room work but keeps current room work running', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const id = add(h)
    h.manager.start(id)
    await flush()
    h.manager.retainRoom('100', false)
    expect(h.attempts[0]!.signal.aborted).toBe(false)
    h.manager.retainRoom('100', true)
    h.manager.setRoom('200')
    h.manager.retainRoom('100', false)
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    expect(status(h, id).status).toBe('stopped')
  })

  it('removes pending work without resurrecting it from a late completion', async () => {
    const h = harness()
    h.manager.retainRoom('200', true)
    const removed = add(h, { repeatMinutes: 60 })
    const next = add(h, { room: '200' })
    h.manager.start(removed)
    h.manager.start(next)
    await flush()
    h.manager.remove(removed)
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.manager.snapshot().tasks.map(task => task.id)).toEqual([next])
    expect(h.attempts[1]!.task.id).toBe(next)
    expect(h.saved().tasks.map(task => task.id)).toEqual([next])
  })

  it('removes only the specified account and invalidates its in-flight result', async () => {
    const h = harness()
    const removed = add(h)
    const other = add(h, { accountId: ACCOUNT_B })
    h.manager.start(removed)
    await flush()
    h.manager.removeAccount('default')
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(h.manager.snapshot()).toMatchObject({ activeAccountId: null, tasks: [{ id: other, accountId: ACCOUNT_B }] })
    expect(h.saved().tasks.map(task => task.accountId)).toEqual([ACCOUNT_B])
  })

  it('stops everything at disposal and ignores late results and runtime wakeups', async () => {
    const h = harness()
    h.manager.retainRoom('200', true)
    const current = add(h, { repeatMinutes: 60 })
    const next = add(h, { room: '200' })
    h.manager.start(current)
    h.manager.start(next)
    await flush()
    const saves = h.save.mock.calls.length
    h.manager.dispose()
    const ended = h.manager.snapshot()
    expect(ended.tasks.every(task => task.status === 'stopped' && task.nextRunAt === null)).toBe(true)
    expect(h.attempts[0]!.signal.aborted).toBe(true)
    h.attempts[0]!.resolve(SUCCESS)
    h.manager.setRuntime(FOREGROUND)
    h.manager.setActiveAccount('default')
    h.manager.setRoom('100')
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(h.manager.snapshot()).toEqual(ended)
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.save).toHaveBeenCalledTimes(saves)
    expect(() => h.manager.start(next)).toThrow(expect.objectContaining({ code: 'disposed' }))
  })
})

describe('Douyu repeats and persistence failures', () => {
  it('arms a repeat only after explicit success and does not let duplicate start bypass its deadline', async () => {
    const h = harness()
    const id = add(h, { repeatMinutes: 60 })
    h.manager.start(id)
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    const due = Date.now() + 60 * 60_000
    expect(status(h, id)).toMatchObject({ status: 'queued', nextRunAt: due, lastResult: SUCCESS.message })
    h.manager.start(id)
    await vi.advanceTimersByTimeAsync(59 * 60_000)
    expect(h.run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.run).toHaveBeenCalledTimes(2)
    h.attempts[1]!.resolve(FAILED)
    await flush()
    expect(status(h, id)).toMatchObject({ status: 'failed', nextRunAt: null })
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it.each([WAITING, FAILED])('does not automatically retry a $status result when the app returns', async outcome => {
    const h = harness()
    const id = add(h, { repeatMinutes: 60 })
    h.manager.start(id)
    await flush()
    h.attempts[0]!.resolve(outcome)
    await flush()
    h.manager.setRuntime(BACKGROUND)
    h.manager.setRuntime(FOREGROUND)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(status(h, id)).toMatchObject({ status: outcome.status, lastResult: outcome.message, nextRunAt: null })
    expect(h.run).toHaveBeenCalledOnce()
    h.manager.start(id)
    await flush()
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('keeps a future repeat armed through a temporary gate closure until the original deadline', async () => {
    const h = harness()
    const id = add(h, { repeatMinutes: 60 })
    h.manager.start(id)
    await flush()
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    const due = status(h, id).nextRunAt
    h.manager.setRuntime(BACKGROUND)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    h.manager.setRuntime(FOREGROUND)
    expect(status(h, id)).toMatchObject({ status: 'queued', nextRunAt: due })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(h.run).toHaveBeenCalledTimes(2)
  })

  it('uses safe timer checkpoints for the longest supported repeat and clears them on pause', async () => {
    const h = harness()
    const id = add(h, { repeatMinutes: 43_200 })
    h.manager.start(id)
    await flush()
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    const duration = 43_200 * 60_000
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(h.run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(duration - 2_147_483_647 - 1)
    expect(h.run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.run).toHaveBeenCalledTimes(2)
    h.attempts[1]!.resolve(SUCCESS)
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    h.manager.pause(id)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sanitizes a rejected runner and refuses an invalid success response', async () => {
    const h = harness()
    const id = add(h, { repeatMinutes: 60 })
    h.manager.start(id)
    await flush()
    h.attempts[0]!.reject(new Error('COOKIE_PRIVATE'))
    await flush()
    expect(status(h, id)).toMatchObject({ status: 'failed', nextRunAt: null })
    expect(JSON.stringify(h.manager.snapshot())).not.toContain('COOKIE_PRIVATE')
    h.manager.start(id)
    await flush()
    h.attempts[1]!.resolve({ status: 'succeeded', message: '', raw: 'COOKIE_PRIVATE' } as never)
    await flush()
    expect(status(h, id)).toMatchObject({ status: 'failed', nextRunAt: null })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not create a task after persistence fails and accepts an explicit retry', async () => {
    const h = harness()
    h.save.mockImplementationOnce(() => { throw new Error('PRIVATE_PATH') })
    expect(() => add(h)).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    await flush()
    expect(h.manager.snapshot().tasks).toEqual([])
    expect(h.run).not.toHaveBeenCalled()
    expect(h.saved()).toBeUndefined()
    const id = add(h)
    expect(status(h, id).status).toBe('paused')
    expect(h.saved().tasks).toEqual([expect.objectContaining({ id, ...INPUT })])
    await flush()
    expect(h.run).not.toHaveBeenCalled()
    h.manager.start(id)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('does not dispatch a queued task when saving a more permissive policy fails', async () => {
    const h = harness()
    h.manager.setRuntime(BACKGROUND)
    const id = add(h)
    h.manager.start(id)
    const before = h.manager.snapshot()
    const beforeSaved = h.saved()
    h.save.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => h.manager.setPolicy(id, 'background-locked')).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    await flush()
    expect(h.manager.snapshot()).toEqual(before)
    expect(h.saved()).toEqual(beforeSaved)
    expect(h.run).not.toHaveBeenCalled()
    h.manager.setPolicy(id, 'background-locked')
    await flush()
    expect(h.attempts.map(attempt => attempt.task)).toEqual([expect.objectContaining({ id, policy: 'background-locked' })])
  })

  it('does not admit a queued room after failed retention, even when the execution lane becomes free', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const running = add(h)
    const waiting = add(h, { room: '200' })
    h.manager.start(running)
    h.manager.start(waiting)
    await flush()
    h.manager.setRoom('300')
    const before = h.manager.snapshot()
    const beforeSaved = h.saved()
    h.save.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => h.manager.retainRoom('200', true)).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(h.manager.snapshot()).toEqual(before)
    expect(h.saved()).toEqual(beforeSaved)
    expect(h.attempts[0]!.signal.aborted).toBe(false)
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    expect(status(h, waiting)).toMatchObject({ status: 'queued', reason: '等待进入或保留该房间' })
    expect(h.run).toHaveBeenCalledOnce()
    h.manager.retainRoom('200', true)
    await flush()
    expect(h.attempts.map(attempt => attempt.task.id)).toEqual([running, waiting])
    expect(h.saved().retainedRooms).toEqual(['100', '200'])
  })

  it.each(['policy', 'unretain-current'] as const)(
    'keeps configuration and a running request unchanged when %s persistence fails', async operation => {
      const h = harness()
      h.manager.retainRoom('100', true)
      h.manager.setRuntime(BACKGROUND)
      const id = add(h, { policy: 'background-unlocked' })
      h.manager.start(id)
      await flush()
      if (operation === 'policy') h.manager.setRoom('200')
      const before = h.manager.snapshot()
      const beforeSaved = h.saved()
      h.save.mockImplementationOnce(() => { throw new Error('PRIVATE_PATH') })
      const operationMap = {
        policy: () => h.manager.setPolicy(id, 'foreground'),
        'unretain-current': () => h.manager.retainRoom('100', false),
      }
      expect(operationMap[operation]).toThrow(expect.objectContaining({ code: 'storage-failed' }))
      await flush()
      expect(h.manager.snapshot()).toEqual(before)
      expect(h.saved()).toEqual(beforeSaved)
      expect(h.attempts[0]!.signal.aborted).toBe(false)
      expect(h.run).toHaveBeenCalledOnce()
    },
  )

  it.each([
    { operation: 'remove', affected: ['running'] },
    { operation: 'remove-account', affected: ['running', 'sameAccount'] },
    { operation: 'unretain', affected: ['running', 'sameRoom'] },
    { operation: 'close', affected: ['running', 'sameRoom'] },
  ] as const)('stops affected work before a failed $operation save, ignores late results and accepts a retry', async ({ operation, affected }) => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const ids = {
      running: add(h, { repeatMinutes: 60 }),
      sameAccount: add(h, { room: '200' }),
      sameRoom: add(h, { accountId: ACCOUNT_B }),
    }
    for (const id of Object.values(ids)) h.manager.start(id)
    await flush()
    h.manager.setRoom('300')
    const before = h.manager.snapshot()
    const beforeSaved = h.saved()
    const affectedIds = affected.map(key => ids[key])
    const observer = vi.fn()
    h.manager.subscribe(observer)
    observer.mockClear()
    let atSave: unknown
    h.save.mockImplementationOnce(() => {
      atSave = { aborted: h.attempts[0]!.signal.aborted, tasks: affectedIds.map(id => status(h, id)) }
      throw new Error('PRIVATE_PATH')
    })
    const operationMap = {
      remove: () => h.manager.remove(ids.running),
      'remove-account': () => h.manager.removeAccount('default'),
      unretain: () => h.manager.retainRoom('100', false),
      close: () => h.manager.closeRoom('100'),
    }
    expect(operationMap[operation]).toThrow(expect.objectContaining({
      code: 'storage-failed', message: expect.stringContaining('相关任务已停止, 配置修改未保存'),
    }))
    expect(atSave).toEqual({
      aborted: true,
      tasks: affectedIds.map(id => expect.objectContaining({ id, status: 'stopped', nextRunAt: null })),
    })
    const stopped = h.manager.snapshot()
    expect(stopped).toEqual({
      ...before,
      tasks: before.tasks.map(task => affectedIds.includes(task.id)
        ? { ...task, status: 'stopped', nextRunAt: null, reason: expect.stringContaining('配置修改未保存') }
        : task),
    })
    expect(status(h, ids.running).reason).toContain('请求可能已处理')
    expect(observer).toHaveBeenLastCalledWith(stopped)
    expect(h.saved()).toEqual(beforeSaved)
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    h.manager.setRuntime(BACKGROUND)
    h.manager.setRuntime(FOREGROUND)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(h.manager.snapshot()).toEqual(stopped)
    expect(h.saved()).toEqual(beforeSaved)
    expect(h.run).toHaveBeenCalledOnce()

    expect(operationMap[operation]).not.toThrow()
    const removing = operation === 'remove' || operation === 'remove-account'
    const expectedDefinitions = removing
      ? beforeSaved.tasks.filter(task => !affectedIds.includes(task.id)) : beforeSaved.tasks
    expect(h.saved()).toEqual({
      ...beforeSaved, tasks: expectedDefinitions, retainedRooms: removing ? ['100'] : [],
    })
    expect(h.manager.snapshot()).toMatchObject({
      activeAccountId: operation === 'remove-account' ? null : 'default',
      currentRoom: '300', retainedRooms: removing ? ['100'] : [],
    })
    expect(h.manager.snapshot().tasks.map(task => task.id)).toEqual(expectedDefinitions.map(task => task.id))
    if (!removing) {
      for (const id of affectedIds) {
        expect(status(h, id)).toMatchObject({ status: 'stopped', nextRunAt: null, lastResult: null })
        expect(status(h, id).reason).not.toContain('配置修改未保存')
      }
    }
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('preserves another room\'s existing repeat deadline when closing a room cannot be saved', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    h.manager.retainRoom('200', true)
    const stopped = add(h, { repeatMinutes: 60 })
    const otherRoom = add(h, { room: '200', repeatMinutes: 60 })
    h.manager.start(stopped)
    h.manager.start(otherRoom)
    await flush()
    h.attempts[0]!.resolve(SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    h.attempts[1]!.resolve(SUCCESS)
    await flush()
    const beforeOther = status(h, otherRoom)
    const beforeSaved = h.saved()
    h.save.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => h.manager.closeRoom('100')).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(status(h, stopped)).toMatchObject({ status: 'stopped', nextRunAt: null, lastResult: SUCCESS.message })
    expect(status(h, otherRoom)).toEqual(beforeOther)
    expect(h.manager.snapshot().currentRoom).toBe('100')
    expect(h.saved()).toEqual(beforeSaved)
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
    expect(h.run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.attempts.map(attempt => attempt.task.id)).toEqual([stopped, otherRoom, otherRoom])
    expect(h.attempts[2]!.signal.aborted).toBe(false)
    expect(status(h, otherRoom)).toMatchObject({ status: 'running', lastRunAt: beforeOther.nextRunAt })
    h.manager.closeRoom('100')
    expect(h.manager.snapshot()).toMatchObject({ currentRoom: null, retainedRooms: ['200'] })
    expect(h.saved().retainedRooms).toEqual(['200'])
    expect(h.attempts[2]!.signal.aborted).toBe(false)
    h.attempts[2]!.resolve(SUCCESS)
    await flush()
    expect(status(h, otherRoom)).toMatchObject({ status: 'queued', nextRunAt: Date.now() + 60 * 60_000 })
    expect(status(h, stopped).status).toBe('stopped')
  })
})
