import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateDouyuTask, DouyuMessageInput, DouyuMessageOutcome, DouyuMessageSchedule,
  DouyuTaskDefinition, DouyuTaskOutcome, DouyuTaskStorage,
} from '../server/douyu/types'
import { DouyuTaskManager } from './douyuTasks'

const ACCOUNT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREGROUND = { foreground: true, locked: false, suspended: false }
const BACKGROUND = { foreground: false, locked: false, suspended: false }
const SCHEDULE: DouyuMessageSchedule = { text: 'SYNTHETIC_LOOP_TEXT', colors: [2, 6], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 3 }
const LOOP: CreateDouyuTask = { accountId: 'default', room: '100', kind: 'message-loop', policy: 'foreground', repeatMinutes: null, message: SCHEDULE }
const SIGN: CreateDouyuTask = { accountId: 'default', room: '100', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }
const SUCCESS: DouyuMessageOutcome = { status: 'succeeded', message: '已收到发送回执', nextAllowedAt: null }
const SIGN_SUCCESS: DouyuTaskOutcome = { status: 'succeeded', message: '签到成功' }
const managers: DouyuTaskManager[] = []

interface Attempt<T, R> {
  input: T
  signal: AbortSignal
  resolve: (result: R) => void
  reject: (error: unknown) => void
}

function harness(initial: unknown = undefined, ready = true) {
  let saved = initial
  let serial = 0
  const messages: Attempt<DouyuMessageInput, DouyuMessageOutcome>[] = []
  const signs: Attempt<DouyuTaskDefinition, DouyuTaskOutcome>[] = []
  const save = vi.fn((data: DouyuTaskStorage) => { saved = structuredClone(data) })
  const send = vi.fn((input: DouyuMessageInput, signal: AbortSignal) => new Promise<DouyuMessageOutcome>((resolve, reject) => {
    messages.push({ input, signal, resolve, reject })
  }))
  const run = vi.fn((input: DouyuTaskDefinition, signal: AbortSignal) => new Promise<DouyuTaskOutcome>((resolve, reject) => {
    signs.push({ input, signal, resolve, reject })
  }))
  const manager = new DouyuTaskManager({ load: () => saved, save, run, sendMessage: send,
    id: () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}` })
  managers.push(manager)
  if (ready) restore(manager)
  return { manager, messages, signs, save, send, run, saved: () => structuredClone(saved) as DouyuTaskStorage }
}

function restore(manager: DouyuTaskManager): void {
  manager.setActiveAccount('default')
  manager.setRoom('100')
  manager.setRuntime(FOREGROUND)
}

function add(h: ReturnType<typeof harness>, message: Partial<DouyuMessageSchedule> = {}, task: Partial<CreateDouyuTask> = {}): string {
  return h.manager.create({ ...LOOP, message: { ...SCHEDULE, colors: [...SCHEDULE.colors], ...message }, ...task }).tasks.at(-1)!.id
}

function view(h: ReturnType<typeof harness>, id: string) { return h.manager.snapshot().tasks.find(task => task.id === id)! }
async function flush(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers() })

describe('message loop definitions and scheduling', () => {
  it('stores version 1 definitions with no runtime counters and keeps old sign tasks compatible', async () => {
    const h = harness()
    const sign = h.manager.create(SIGN).tasks[0]!.id
    const id = add(h)
    expect(view(h, sign)).not.toHaveProperty('message')
    expect(view(h, sign)).not.toHaveProperty('completedRuns')
    expect(view(h, id)).toMatchObject({ status: 'paused', completedRuns: 0, message: SCHEDULE })
    expect(h.saved().version).toBe(1)
    expect(h.saved().tasks[1]!.message).toEqual(SCHEDULE)
    expect(h.saved().tasks.every(task => !Object.hasOwn(task, 'completedRuns'))).toBe(true)
    expect(() => add(h, { text: 'another message' })).toThrow(expect.objectContaining({ code: 'task-exists' }))
    const restored = harness(h.saved())
    await flush()
    expect(restored.manager.snapshot().tasks.map(task => task.status)).toEqual(['paused', 'paused'])
    expect(restored.run).not.toHaveBeenCalled()
    expect(restored.send).not.toHaveBeenCalled()
  })

  it('applies initial delay once per explicit round and rotates only after confirmed successes', async () => {
    const h = harness()
    const id = add(h, { colors: [2, 6, 0], initialDelaySeconds: 5, intervalSeconds: 2, maxRuns: 3 })
    const firstAt = Date.now() + 5_000
    h.manager.start(id)
    expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: 0, nextRunAt: firstAt })
    await vi.advanceTimersByTimeAsync(4_999)
    h.manager.start(id)
    expect(view(h, id).nextRunAt).toBe(firstAt)
    expect(h.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.messages[0]!.input.color).toBe(2)
    h.manager.start(id)
    expect(h.send).toHaveBeenCalledOnce()
    for (let index = 0; index < 3; index++) {
      expect(h.messages[index]!.input.color).toBe([2, 6, 0][index])
      expect(view(h, id).completedRuns).toBe(index)
      h.messages[index]!.resolve(SUCCESS)
      await flush()
      expect(view(h, id).completedRuns).toBe(index + 1)
      if (index < 2) {
        const nextAt = Date.now() + 2_000
        expect(view(h, id)).toMatchObject({ status: 'queued', nextRunAt: nextAt })
        h.manager.start(id)
        expect(view(h, id)).toMatchObject({ completedRuns: index + 1, nextRunAt: nextAt })
        await vi.advanceTimersByTimeAsync(1_999)
        expect(h.send).toHaveBeenCalledTimes(index + 1)
        await vi.advanceTimersByTimeAsync(1)
      }
    }
    expect(view(h, id)).toMatchObject({ status: 'succeeded', completedRuns: 3, nextRunAt: null })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(h.send).toHaveBeenCalledTimes(3)
    h.manager.start(id)
    expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: 0, nextRunAt: Date.now() + 5_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.messages[3]!.input.color).toBe(2)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('continues an unlimited loop until an explicit pause and resets progress after restart', async () => {
    const h = harness()
    const id = add(h, { colors: [6, 4], intervalSeconds: 1, maxRuns: null })
    h.manager.start(id)
    await flush()
    for (let index = 0; index < 5; index++) {
      expect(h.messages[index]!.input.color).toBe(index % 2 === 0 ? 6 : 4)
      h.messages[index]!.resolve(SUCCESS)
      await flush()
      expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: index + 1 })
      if (index < 4) await vi.advanceTimersByTimeAsync(1_000)
    }
    h.manager.pause(id)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(h.send).toHaveBeenCalledTimes(5)
    const restored = harness(h.saved())
    expect(view(restored, id)).toMatchObject({ status: 'paused', completedRuns: 0, nextRunAt: null })
    expect(restored.send).not.toHaveBeenCalled()
    restored.manager.start(id)
    await flush()
    expect(restored.messages[0]!.input.color).toBe(6)
  })

  it('uses the later completion-based interval or server cooldown deadline', async () => {
    const h = harness()
    const id = add(h, { intervalSeconds: 10, maxRuns: 2 })
    h.manager.start(id)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    const nextAllowedAt = Date.now() + 60_000
    h.messages[0]!.resolve({ ...SUCCESS, nextAllowedAt })
    await flush()
    expect(view(h, id)).toMatchObject({ completedRuns: 1, nextRunAt: nextAllowedAt })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(h.send).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.messages[1]!.input.color).toBe(6)
    h.messages[1]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'succeeded', nextRunAt: null, completedRuns: 2 })
  })

  it('waits on proven unsent deferral without advancing either count or color', async () => {
    const h = harness()
    const id = add(h, { colors: [1, 5], intervalSeconds: 1, maxRuns: 2 })
    h.manager.start(id)
    await flush()
    const deferredUntil = Date.now() + 30_000
    const nextAllowedAt = deferredUntil + 5_000
    h.messages[0]!.resolve({ status: 'waiting-user', message: '尚未发送, 等待已知冷却', deferredUntil, nextAllowedAt })
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: 0, nextRunAt: nextAllowedAt })
    h.manager.start(id)
    expect(view(h, id).nextRunAt).toBe(nextAllowedAt)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(h.messages.map(attempt => attempt.input.color)).toEqual([1, 1])
    h.messages[1]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id).completedRuns).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.messages[2]!.input.color).toBe(5)
    h.messages[2]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'succeeded', completedRuns: 2, nextRunAt: null })
  })
})

describe('message loop configuration boundaries', () => {
  it.each([
    { ...SIGN, kind: 'message-loop' }, { ...LOOP, message: undefined }, { ...LOOP, repeatMinutes: 60 },
    { ...SIGN, message: SCHEDULE }, { ...SIGN, message: undefined },
    { ...LOOP, message: { ...SCHEDULE, colors: [1, 1] } },
    { ...LOOP, message: { ...SCHEDULE, intervalSeconds: 0 } }, { ...LOOP, extra: true },
  ])('rejects unsupported creation shapes before saving: %#', raw => {
    const h = harness()
    expect(() => h.manager.create(raw as CreateDouyuTask)).toThrow(expect.objectContaining({ code: 'invalid-arguments' }))
    expect(h.save).not.toHaveBeenCalled()
    expect(h.manager.snapshot().tasks).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
  })

  it.each([
    { ...SIGN, kind: 'message-loop' }, { ...LOOP, repeatMinutes: 60 }, { ...LOOP, completedRuns: 1 },
    { ...SIGN, message: SCHEDULE }, { ...SIGN, message: undefined },
    { ...LOOP, message: { ...SCHEDULE, maxRuns: 0 } },
    { ...LOOP, message: { ...SCHEDULE, colors: [6, 6] } },
  ])('refuses corrupt stored loops without overwriting the original definition: %#', fields => {
    const raw = { version: 1, retainedRooms: [], tasks: [{ ...fields, id: 'default', createdAt: 1_800_000_000_000 }] }
    const before = structuredClone(raw)
    const save = vi.fn()
    expect(() => new DouyuTaskManager({ load: () => raw, save, run: vi.fn(), sendMessage: vi.fn() }))
      .toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(save).not.toHaveBeenCalled()
    expect(raw).toEqual(before)
  })

  it('isolates inputs, snapshots, observers, save callbacks and transport mutations from later runs', async () => {
    const h = harness()
    const input = { ...SCHEDULE, colors: [...SCHEDULE.colors], intervalSeconds: 1 }
    const returned = h.manager.create({ ...LOOP, message: input })
    const id = returned.tasks[0]!.id
    input.text = 'CHANGED_INPUT'
    input.colors[0] = 0
    returned.tasks[0]!.message!.text = 'CHANGED_SNAPSHOT'
    returned.tasks[0]!.message!.colors.length = 0
    h.save.mock.calls[0]![0].tasks[0]!.message!.colors[0] = 0
    h.manager.subscribe(snapshot => {
      const task = snapshot.tasks.find(task => task.id === id)!
      task.message!.text = 'CHANGED_OBSERVER'
      task.message!.colors.length = 0
      task.completedRuns = 999
      throw new Error('synthetic observer failure')
    })
    h.save.mockImplementationOnce(data => {
      data.tasks[0]!.message!.text = 'CHANGED_SAVE'
      data.tasks[0]!.message!.colors[0] = 0
    })
    h.manager.setPolicy(id, 'background-locked')
    expect(view(h, id)).toMatchObject({ message: { ...SCHEDULE, intervalSeconds: 1 }, completedRuns: 0 })
    h.manager.start(id)
    await flush()
    expect(h.messages[0]!.input).toMatchObject({ text: SCHEDULE.text, color: 2 })
    h.messages[0]!.input.text = 'CHANGED_TRANSPORT'
    h.messages[0]!.input.color = 0
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id).completedRuns).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.messages[1]!.input).toMatchObject({ text: SCHEDULE.text, color: 6 })
    expect(h.run).not.toHaveBeenCalled()
  })

  it('clones nested message data when loading a stored definition', async () => {
    const raw: DouyuTaskStorage = { version: 1, retainedRooms: [], tasks: [{ ...LOOP, id: 'default', createdAt: 1_800_000_000_000,
      message: { ...SCHEDULE, colors: [...SCHEDULE.colors] } }] }
    const h = harness(raw)
    raw.tasks[0]!.message!.text = 'CHANGED_STORED_TEXT'
    raw.tasks[0]!.message!.colors[0] = 0
    h.manager.start('default')
    await flush()
    expect(h.messages[0]!.input).toMatchObject({ text: SCHEDULE.text, color: 2 })
  })
})

describe('message loop outcomes and execution ownership', () => {
  it.each([
    { raw: { status: 'waiting-user', message: '发送成功', nextAllowedAt: 1_800_000_030_000 }, status: 'waiting-user' },
    { raw: { status: 'failed', message: '等待人工处理', nextAllowedAt: null }, status: 'failed' },
    { raw: { status: 'succeeded', message: '', nextAllowedAt: null }, status: 'failed' },
    { raw: { status: 'succeeded', message: '成功', nextAllowedAt: null, response: { ok: true } }, status: 'failed' },
    { raw: { status: 200, ok: true, message: '发送成功' }, status: 'failed' },
  ])('does not turn an unconfirmed result into a repeat: %#', async ({ raw, status }) => {
    const h = harness()
    const id = add(h, { intervalSeconds: 1, maxRuns: null })
    h.manager.start(id)
    await flush()
    h.messages[0]!.resolve(raw as DouyuMessageOutcome)
    await flush()
    expect(view(h, id)).toMatchObject({ status, completedRuns: 0, nextRunAt: null })
    h.manager.setRuntime(BACKGROUND)
    restore(h.manager)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(h.send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['succeeded', 'failed', 'past', 'missing-next', 'earlier-next', 'unsafe', 'extra'] as const)
  ('rejects an invalid %s deferral rather than scheduling or counting it', async invalid => {
    const h = harness()
    const id = add(h, { intervalSeconds: 1, maxRuns: null })
    h.manager.start(id)
    await flush()
    const deferred = { status: 'waiting-user', message: '尚未发送', nextAllowedAt: Date.now() + 5_000, deferredUntil: Date.now() + 5_000 }
    const outcomes = {
      succeeded: { ...deferred, status: 'succeeded' }, failed: { ...deferred, status: 'failed' },
      past: { ...deferred, deferredUntil: Date.now() }, 'missing-next': { ...deferred, nextAllowedAt: null },
      'earlier-next': { ...deferred, nextAllowedAt: Date.now() + 4_000 },
      unsafe: { ...deferred, deferredUntil: Infinity }, extra: { ...deferred, raw: 'SYNTHETIC_SECRET' },
    }
    h.messages[0]!.resolve(outcomes[invalid] as DouyuMessageOutcome)
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'failed', completedRuns: 0, nextRunAt: null })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.send).toHaveBeenCalledOnce()
    expect(JSON.stringify(view(h, id))).not.toContain('SYNTHETIC_SECRET')
  })

  it('keeps confirmed progress after an error and begins a fresh round only on explicit start', async () => {
    const h = harness()
    const id = add(h, { intervalSeconds: 1, initialDelaySeconds: 2 })
    h.manager.start(id)
    await vi.advanceTimersByTimeAsync(2_000)
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.messages[1]!.input.color).toBe(6)
    h.messages[1]!.reject(new Error('SYNTHETIC_SECRET'))
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'failed', completedRuns: 1, nextRunAt: null })
    expect(view(h, id).lastResult).not.toContain('SYNTHETIC_SECRET')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.send).toHaveBeenCalledTimes(2)
    h.manager.start(id)
    expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: 0, nextRunAt: Date.now() + 2_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.messages[2]!.input.color).toBe(2)
  })

  it('serializes sign, manual and loop writes through one lane', async () => {
    const h = harness()
    const sign = h.manager.create(SIGN).tasks[0]!.id
    const loop = add(h, { intervalSeconds: 1, maxRuns: 2 })
    h.manager.start(sign)
    await flush()
    const manual = h.manager.sendMessage({ accountId: 'default', room: '100', text: 'MANUAL_TEXT', color: 0 })
    h.manager.start(loop)
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.messages[0]!.input.text).toBe('MANUAL_TEXT')
    expect(h.send).toHaveBeenCalledOnce()
    h.messages[0]!.resolve(SUCCESS)
    await manual
    await flush()
    expect(h.messages[1]!.input.text).toBe(SCHEDULE.text)
    h.manager.start(sign)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    h.messages[1]!.resolve(SUCCESS)
    await flush()
    expect(h.run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.send).toHaveBeenCalledTimes(2)
    h.signs[1]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.messages[2]!.input.color).toBe(6)
    expect(h.signs.every(attempt => attempt.input.kind === 'room-sign')).toBe(true)
  })

  it('keeps a cancelled loop in the lane until settlement and ignores late progress from the old round', async () => {
    const h = harness()
    const id = add(h, { intervalSeconds: 1, initialDelaySeconds: 1 })
    h.manager.start(id)
    await vi.advanceTimersByTimeAsync(1_000)
    h.manager.pause(id)
    expect(h.messages[0]!.signal.aborted).toBe(true)
    h.manager.start(id)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.send).toHaveBeenCalledOnce()
    expect(view(h, id)).toMatchObject({ status: 'queued', completedRuns: 0 })
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    expect(h.send).toHaveBeenCalledTimes(2)
    expect(h.messages[1]!.input.color).toBe(2)
    expect(view(h, id)).toMatchObject({ status: 'running', completedRuns: 0, lastResult: null })
    h.messages[1]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id).completedRuns).toBe(1)
  })
})

describe('message loop lifecycle and policies', () => {
  it.each(['account', 'credentials', 'room', 'close-room', 'background', 'locked', 'suspended', 'remove', 'dispose'] as const)
  ('cancels active loops on %s and never uses a late receipt or deferral', async event => {
    const h = harness()
    const id = add(h, { intervalSeconds: 1, maxRuns: null })
    h.manager.start(id)
    await flush()
    const actions = {
      account: () => h.manager.setActiveAccount(ACCOUNT_B), credentials: () => h.manager.pauseAccount('default'),
      room: () => h.manager.setRoom('200'), 'close-room': () => h.manager.closeRoom('100'),
      background: () => h.manager.setRuntime(BACKGROUND), locked: () => h.manager.setRuntime({ ...FOREGROUND, locked: true }),
      suspended: () => h.manager.setRuntime({ ...FOREGROUND, suspended: true }),
      remove: () => h.manager.remove(id), dispose: () => h.manager.dispose(),
    }
    actions[event]()
    expect(h.messages[0]!.signal.aborted).toBe(true)
    const stopped = h.manager.snapshot().tasks
    restore(h.manager)
    h.messages[0]!.resolve({ status: 'waiting-user', message: '尚未发送', nextAllowedAt: Date.now() + 1_000, deferredUntil: Date.now() + 1_000 })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.manager.snapshot().tasks).toEqual(stopped)
    if (event !== 'remove') expect(view(h, id).completedRuns).toBe(0)
  })

  it('uses the configured background and retained-room policy without granting it to manual sends', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const id = add(h, { intervalSeconds: 1, maxRuns: null }, { policy: 'background-locked' })
    h.manager.setRoom('200')
    h.manager.setRuntime({ foreground: false, locked: true, suspended: false })
    h.manager.start(id)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.messages[0]!.signal.aborted).toBe(false)
    expect(await h.manager.sendMessage({ accountId: 'default', room: '100', text: 'MANUAL_TEXT', color: 0 }))
      .toMatchObject({ status: 'failed' })
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.send).toHaveBeenCalledTimes(2)
    h.manager.retainRoom('100', false)
    expect(h.messages[1]!.signal.aborted).toBe(true)
    h.messages[1]!.resolve(SUCCESS)
    await flush()
    expect(view(h, id)).toMatchObject({ status: 'stopped', completedRuns: 1, nextRunAt: null })
  })

  it('permits unlocked background execution but pauses it when the session locks', async () => {
    const h = harness()
    const id = add(h, {}, { policy: 'background-unlocked' })
    h.manager.setRuntime(BACKGROUND)
    h.manager.start(id)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
    h.manager.setRuntime({ ...BACKGROUND, locked: true })
    expect(h.messages[0]!.signal.aborted).toBe(true)
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    h.manager.setRuntime(BACKGROUND)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(view(h, id)).toMatchObject({ status: 'paused', completedRuns: 0, nextRunAt: null })
    expect(h.send).toHaveBeenCalledOnce()
  })

  it('cancels a loop before a failed room-close save and discards its late successful receipt', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const id = add(h)
    h.manager.start(id)
    await flush()
    const before = h.saved()
    h.save.mockImplementationOnce(() => {
      expect(h.messages[0]!.signal.aborted).toBe(true)
      throw new Error('SYNTHETIC_PRIVATE_PATH')
    })
    expect(() => h.manager.closeRoom('100')).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(h.saved()).toEqual(before)
    h.messages[0]!.resolve(SUCCESS)
    await flush()
    restore(h.manager)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(view(h, id)).toMatchObject({ status: 'stopped', completedRuns: 0, nextRunAt: null })
    expect(h.send).toHaveBeenCalledOnce()
  })
})
