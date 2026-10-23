import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateDouyuTask, DouyuMessageInput, DouyuMessageOutcome, DouyuRuntimeState,
  DouyuTaskDefinition, DouyuTaskOutcome, DouyuTaskStorage,
} from '../server/douyu/types'
import { DouyuTaskManager } from './douyuTasks'

const ACCOUNT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREGROUND: DouyuRuntimeState = { foreground: true, locked: false, suspended: false }
const BACKGROUND: DouyuRuntimeState = { foreground: false, locked: false, suspended: false }
const INPUT: DouyuMessageInput = { accountId: 'default', room: '100', text: 'SYNTHETIC_PRIVATE_MESSAGE', color: 0 }
const SIGN: CreateDouyuTask = { accountId: 'default', room: '100', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }
const SIGN_SUCCESS: DouyuTaskOutcome = { status: 'succeeded', message: '签到成功' }
const SUCCESS: DouyuMessageOutcome = { status: 'succeeded', message: '发送成功', nextAllowedAt: null }
const FAILURE: DouyuMessageOutcome = { status: 'failed', message: '弹幕发送失败, 请检查当前账号与房间后手动重试', nextAllowedAt: null }
const managers: DouyuTaskManager[] = []

interface Attempt<T, R> {
  input: T
  signal: AbortSignal
  resolve: (result: R) => void
  reject: (error: unknown) => void
}

function harness(initial?: DouyuTaskStorage, ready = true) {
  let saved = structuredClone(initial)
  let serial = 0
  const signs: Attempt<DouyuTaskDefinition, DouyuTaskOutcome>[] = []
  const messages: Attempt<DouyuMessageInput, DouyuMessageOutcome>[] = []
  const save = vi.fn((data: DouyuTaskStorage) => { saved = structuredClone(data) })
  const run = vi.fn((input: DouyuTaskDefinition, signal: AbortSignal) => new Promise<DouyuTaskOutcome>((resolve, reject) => {
    signs.push({ input, signal, resolve, reject })
  }))
  const send = vi.fn((input: DouyuMessageInput, signal: AbortSignal) => new Promise<DouyuMessageOutcome>((resolve, reject) => {
    messages.push({ input, signal, resolve, reject })
  }))
  const manager = new DouyuTaskManager({ load: () => saved, save, run, sendMessage: send,
    id: () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}` })
  managers.push(manager)
  if (ready) restore(manager)
  return { manager, signs, messages, save, run, send, saved: () => structuredClone(saved) }
}

function restore(manager: DouyuTaskManager): void {
  manager.setActiveAccount('default')
  manager.setRoom('100')
  manager.setRuntime(FOREGROUND)
}

function add(h: ReturnType<typeof harness>, values: Partial<CreateDouyuTask> = {}): string {
  return h.manager.create({ ...SIGN, ...values }).tasks.at(-1)!.id
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  vi.useRealTimers()
})

describe('manual Douyu messages share the task execution lane', () => {
  it('waits behind the current sign request and runs once before the next queued sign', async () => {
    const h = harness()
    const first = add(h)
    const second = add(h, { kind: 'yuba-sign' })
    h.manager.start(first)
    h.manager.start(second)
    await flush()
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.send).not.toHaveBeenCalled()
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.messages[0]!.input).toEqual(INPUT)
    expect(h.messages[0]!.input).not.toHaveProperty('kind')
    expect(h.run).toHaveBeenCalledOnce()
    h.messages[0]!.resolve(SUCCESS)
    expect(await pending).toEqual(SUCCESS)
    await flush()
    expect(h.signs.map(attempt => attempt.input.kind)).toEqual(['room-sign', 'yuba-sign'])
    h.signs[1]!.resolve(SIGN_SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(2 * 24 * 60 * 60_000)
    expect(h.send).toHaveBeenCalledOnce()
  })

  it('keeps a sign queued while a manual message owns the lane', async () => {
    const h = harness()
    const id = add(h)
    const pending = h.manager.sendMessage(INPUT)
    h.manager.start(id)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.manager.snapshot().tasks[0]).toMatchObject({ status: 'queued', reason: '等待前一个请求结束' })
    h.messages[0]!.resolve(SUCCESS)
    await pending
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it.each(['queued', 'sending'] as const)('refuses a second message while the first is %s', async phase => {
    const h = harness()
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    const duplicate = await h.manager.sendMessage({ ...INPUT, text: 'SECOND_PRIVATE_MESSAGE' })
    expect(duplicate).toMatchObject({ status: 'failed', nextAllowedAt: null })
    expect(duplicate.message).toContain('已有一条')
    expect(duplicate.message).not.toContain('PRIVATE_MESSAGE')
    if (phase === 'queued') { h.signs[0]!.resolve(SIGN_SUCCESS); await flush() }
    expect(h.send).toHaveBeenCalledOnce()
    expect(h.messages[0]!.input.text).toBe(INPUT.text)
    h.messages[0]!.resolve(SUCCESS)
    await pending
    const explicitRetry = h.manager.sendMessage({ ...INPUT, text: 'SECOND_PRIVATE_MESSAGE' })
    await flush()
    expect(h.messages[1]!.input.text).toBe('SECOND_PRIVATE_MESSAGE')
    h.messages[1]!.resolve(SUCCESS)
    await explicitRetry
  })

  it.each(['resolve', 'reject'] as const)('keeps a cancelled network request in the lane until its late %s', async settlement => {
    const h = harness()
    const id = add(h)
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    h.manager.pauseAccount('default')
    const cancelled = await pending
    expect(cancelled).toMatchObject({ status: 'waiting-user', nextAllowedAt: null })
    expect(cancelled.message).toContain('可能已处理')
    expect(h.messages[0]!.signal.aborted).toBe(true)
    h.manager.start(id)
    await flush()
    expect(h.run).not.toHaveBeenCalled()
    expect(await h.manager.sendMessage(INPUT)).toMatchObject({ status: 'failed', message: expect.stringContaining('已有一条') })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.run).not.toHaveBeenCalled()
    if (settlement === 'resolve') h.messages[0]!.resolve(SUCCESS)
    else h.messages[0]!.reject(new Error('SYNTHETIC_SECRET'))
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    expect(await pending).toEqual(cancelled)
    expect(h.send).toHaveBeenCalledOnce()
    expect(JSON.stringify(h.manager.snapshot())).not.toContain('SYNTHETIC_')
  })

  it('cancels before dispatch in the same turn without claiming that a message was sent', async () => {
    const h = harness()
    const pending = h.manager.sendMessage(INPUT)
    h.manager.setRuntime(BACKGROUND)
    restore(h.manager)
    const id = add(h)
    h.manager.start(id)
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送'), nextAllowedAt: null })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it.each([1, 2])('rechecks lifecycle after observer publication %s before dispatch', async stopAt => {
    const h = harness()
    let publications = 0
    let armed = false
    h.manager.subscribe(() => {
      if (armed && ++publications === stopAt) {
        armed = false
        h.manager.setRoom(null)
      }
    })
    armed = true
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    expect(h.send).not.toHaveBeenCalled()
    restore(h.manager)
    await flush()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('manual message lifecycle cancellation', () => {
  const changes = ['account', 'logout', 'credentials', 'remove-account', 'room', 'disconnect', 'close-room', 'background', 'locked', 'suspended'] as const
  it.each(changes.flatMap(change => (['queued', 'sending'] as const).map(phase => ({ change, phase }))))
  ('cancels a $phase message on $change and never resumes it automatically', async ({ change, phase }) => {
    const h = harness()
    h.manager.retainRoom('100', true)
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    const operations = {
      account: () => h.manager.setActiveAccount(ACCOUNT_B),
      logout: () => h.manager.setActiveAccount(null),
      credentials: () => h.manager.pauseAccount('default', '账号登录状态已变化'),
      'remove-account': () => h.manager.removeAccount('default'),
      room: () => h.manager.setRoom('200'),
      disconnect: () => h.manager.setRoom(null),
      'close-room': () => h.manager.closeRoom('100'),
      background: () => h.manager.setRuntime(BACKGROUND),
      locked: () => h.manager.setRuntime({ ...FOREGROUND, locked: true }),
      suspended: () => h.manager.setRuntime({ ...FOREGROUND, suspended: true }),
    }
    operations[change]()
    expect(await pending).toMatchObject({ status: phase === 'sending' ? 'waiting-user' : 'failed', nextAllowedAt: null })
    if (phase === 'sending') expect(h.messages[0]!.signal.aborted).toBe(true)
    else expect(h.send).not.toHaveBeenCalled()
    restore(h.manager)
    if (phase === 'sending') h.messages[0]!.resolve(SUCCESS)
    else h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.send).toHaveBeenCalledTimes(phase === 'sending' ? 1 : 0)
  })

  it.each(['queued', 'sending'] as const)('settles a %s caller on disposal even if the transport never responds', async phase => {
    const h = harness()
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    h.manager.dispose()
    expect(await pending).toMatchObject({ status: phase === 'sending' ? 'waiting-user' : 'failed', nextAllowedAt: null })
    const snapshot = h.manager.snapshot()
    if (phase === 'sending') {
      expect(h.messages[0]!.signal.aborted).toBe(true)
      h.messages[0]!.resolve(SUCCESS)
    } else {
      expect(h.signs[0]!.signal.aborted).toBe(true)
      h.signs[0]!.resolve(SIGN_SUCCESS)
    }
    restore(h.manager)
    await flush()
    expect(h.manager.snapshot()).toEqual(snapshot)
    await expect(h.manager.sendMessage(INPUT)).rejects.toMatchObject({ code: 'disposed' })
    expect(h.send).toHaveBeenCalledTimes(phase === 'sending' ? 1 : 0)
  })

  it.each((['close-room', 'remove-account'] as const).flatMap(operation => (['queued', 'sending'] as const).map(phase => ({ operation, phase }))))
  ('stops a $phase message before a $operation save fails', async ({ operation, phase }) => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const id = add(h)
    if (phase === 'queued') { h.manager.start(id); await flush() }
    const beforeSaved = h.saved()
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    h.save.mockImplementationOnce(() => {
      expect(phase === 'sending' ? h.messages[0]!.signal.aborted : h.signs[0]!.signal.aborted).toBe(true)
      throw new Error('SYNTHETIC_PRIVATE_PATH')
    })
    const stop = operation === 'close-room' ? () => h.manager.closeRoom('100') : () => h.manager.removeAccount('default')
    expect(stop).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(await pending).toMatchObject({ status: phase === 'sending' ? 'waiting-user' : 'failed', nextAllowedAt: null })
    expect(h.saved()).toEqual(beforeSaved)
    expect(h.manager.snapshot()).toMatchObject({ activeAccountId: 'default', currentRoom: '100', retainedRooms: ['100'] })
    restore(h.manager)
    if (phase === 'sending') h.messages[0]!.resolve(SUCCESS)
    else h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.send).toHaveBeenCalledTimes(phase === 'sending' ? 1 : 0)
    expect(h.manager.snapshot().tasks[0]).toMatchObject({ status: 'stopped', lastResult: null })
    expect(JSON.stringify(h.manager.snapshot())).not.toContain('SYNTHETIC_')
  })

  it('does not cancel a message when a different account or room is stopped', async () => {
    const h = harness()
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    h.manager.pauseAccount(ACCOUNT_B)
    h.manager.removeAccount(ACCOUNT_B)
    h.manager.closeRoom('200')
    expect(h.messages[0]!.signal.aborted).toBe(false)
    h.messages[0]!.resolve(SUCCESS)
    expect(await pending).toEqual(SUCCESS)
  })

  it.each(['account', 'room', 'disconnected', 'background', 'locked', 'suspended'] as const)
  ('refuses an initially ineligible %s send without waiting for eligibility to return', async gate => {
    const h = harness()
    h.manager.retainRoom('100', true)
    const operations = {
      account: () => h.manager.setActiveAccount(ACCOUNT_B),
      room: () => h.manager.setRoom('200'),
      disconnected: () => h.manager.setRoom(null),
      background: () => h.manager.setRuntime(BACKGROUND),
      locked: () => h.manager.setRuntime({ ...FOREGROUND, locked: true }),
      suspended: () => h.manager.setRuntime({ ...FOREGROUND, suspended: true }),
    }
    operations[gate]()
    expect(await h.manager.sendMessage(INPUT)).toMatchObject({ status: 'failed', nextAllowedAt: null })
    restore(h.manager)
    await flush()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('manual message validation and privacy', () => {
  it.each([
    null, [], {}, new Date(), Object.assign(Object.create({ inherited: true }), INPUT),
    { ...INPUT, extra: true }, { ...INPUT, [Symbol('extra')]: true },
    { accountId: 'default', room: '100', text: 'message' },
    { ...INPUT, accountId: '../outside' }, { ...INPUT, accountId: null },
    { ...INPUT, room: '0' }, { ...INPUT, room: '0100' }, { ...INPUT, room: ' 100' },
    { ...INPUT, room: '1234567890123' }, { ...INPUT, room: 'https://www.douyu.com/100' }, { ...INPUT, room: 100 },
    { ...INPUT, text: '' }, { ...INPUT, text: '   ' }, { ...INPUT, text: 123 }, { ...INPUT, text: 'x'.repeat(501) },
    { ...INPUT, text: '\uD83D\uDE00'.repeat(251) }, { ...INPUT, text: 'bad\ntext' }, { ...INPUT, text: 'bad\ttext' },
    { ...INPUT, text: 'bad\0text' }, { ...INPUT, text: 'bad\x7ftext' }, { ...INPUT, text: 'bad\x85text' },
    { ...INPUT, text: 'bad\uD800' }, { ...INPUT, text: '\uDC00bad' }, { ...INPUT, text: '\uDC00\uD800' },
    { ...INPUT, color: -1 }, { ...INPUT, color: 7 }, { ...INPUT, color: 0.5 },
    { ...INPUT, color: NaN }, { ...INPUT, color: Infinity }, { ...INPUT, color: '1' },
  ])('rejects malformed message input before queueing: %#', async input => {
    const h = harness()
    await expect(h.manager.sendMessage(input as DouyuMessageInput)).rejects.toMatchObject({ code: 'invalid-arguments' })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })

  it('does not invoke input accessors and permits exactly 500 UTF16 units with paired surrogates', async () => {
    const h = harness()
    const getter = vi.fn(() => 'SYNTHETIC_SECRET')
    const withGetter = Object.defineProperty({ ...INPUT }, 'text', { enumerable: true, get: getter })
    await expect(h.manager.sendMessage(withGetter)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(getter).not.toHaveBeenCalled()
    h.manager.setActiveAccount(ACCOUNT_B)
    const text = '\uD83D\uDE00'.repeat(250)
    const plain = Object.assign(Object.create(null), { ...INPUT, accountId: ACCOUNT_B.toUpperCase(), text, color: 6 }) as DouyuMessageInput
    h.send.mockResolvedValueOnce(SUCCESS)
    expect(await h.manager.sendMessage(plain)).toEqual(SUCCESS)
    expect(h.send).toHaveBeenCalledWith({ ...INPUT, accountId: ACCOUNT_B, text, color: 6 }, expect.any(AbortSignal))
  })

  it('copies input for its lifecycle guards and separately for the transport', async () => {
    const h = harness()
    const raw = { ...INPUT }
    const pending = h.manager.sendMessage(raw)
    raw.accountId = ACCOUNT_B
    raw.room = '200'
    raw.text = 'CHANGED_PRIVATE_MESSAGE'
    await flush()
    expect(h.messages[0]!.input).toEqual(INPUT)
    h.messages[0]!.input.accountId = ACCOUNT_B
    h.messages[0]!.input.room = '200'
    h.manager.pauseAccount('default')
    expect(h.messages[0]!.signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ status: 'waiting-user' })
    h.messages[0]!.resolve(SUCCESS)
    await flush()
  })

  it('keeps message text out of definitions, snapshots, saved data and restored work', async () => {
    const h = harness()
    add(h)
    const observed: unknown[] = []
    h.manager.subscribe(snapshot => observed.push(snapshot))
    const before = h.saved()
    const savesBefore = h.save.mock.calls.length
    const pending = h.manager.sendMessage(INPUT)
    await flush()
    expect(h.saved()).toEqual(before)
    expect(h.save).toHaveBeenCalledTimes(savesBefore)
    h.manager.retainRoom('100', true)
    add(h, { kind: 'yuba-sign' })
    const savedDuringSend = h.saved()!
    expect(savedDuringSend.version).toBe(1)
    for (const task of savedDuringSend.tasks) {
      expect(Object.keys(task).sort()).toEqual(['accountId', 'createdAt', 'id', 'kind', 'policy', 'repeatMinutes', 'room'])
    }
    h.messages[0]!.resolve(SUCCESS)
    expect(await pending).toEqual(SUCCESS)
    expect(h.saved()).toEqual(savedDuringSend)
    expect(JSON.stringify([h.save.mock.calls, observed, h.manager.snapshot()])).not.toContain(INPUT.text)
    const restored = harness(h.saved())
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(restored.send).not.toHaveBeenCalled()
    expect(restored.manager.snapshot().tasks.every(task => task.status === 'paused')).toBe(true)
  })

  it.each(['succeeded', 'waiting-user', 'failed'] as const)('returns only fresh sanitized fields for a valid %s response', async status => {
    const h = harness()
    const raw: DouyuMessageOutcome = { status, message: '  手动发送结果  ', nextAllowedAt: Date.now() + 30_000 }
    h.send.mockResolvedValueOnce(raw)
    const result = await h.manager.sendMessage(INPUT)
    expect(result).toEqual({ status, message: '手动发送结果', nextAllowedAt: Date.now() + 30_000 })
    expect(result).not.toBe(raw)
    raw.message = 'SYNTHETIC_SECRET'
    expect(result.message).toBe('手动发送结果')
    expect(h.manager.snapshot().tasks).toEqual([])
  })

  it.each([
    null, [], {}, Object.assign(Object.create({ inherited: true }), SUCCESS),
    { ...SUCCESS, raw: 'SYNTHETIC_SECRET' }, { status: 'succeeded', message: 'sent' },
    { ...SUCCESS, status: 'unexpected' }, { ...SUCCESS, message: '' }, { ...SUCCESS, message: '   ' },
    { ...SUCCESS, message: 'x'.repeat(241) }, { ...SUCCESS, message: 'bad\ntext' },
    { ...SUCCESS, message: 'bad\x85text' }, { ...SUCCESS, message: 'bad\uD800' },
    { ...SUCCESS, message: { secret: 'SYNTHETIC_SECRET' } },
    { ...SUCCESS, nextAllowedAt: -1 }, { ...SUCCESS, nextAllowedAt: 0.5 }, { ...SUCCESS, nextAllowedAt: NaN },
    { ...SUCCESS, nextAllowedAt: Infinity }, { ...SUCCESS, nextAllowedAt: 8_640_000_000_000_001 },
    { ...SUCCESS, nextAllowedAt: Number.MAX_SAFE_INTEGER + 1 }, { ...SUCCESS, nextAllowedAt: '123' },
  ])('replaces invalid transport output with a fixed private-safe failure: %#', async raw => {
    const h = harness()
    h.send.mockResolvedValueOnce(raw as DouyuMessageOutcome)
    expect(await h.manager.sendMessage(INPUT)).toEqual(FAILURE)
    expect(h.manager.snapshot().tasks).toEqual([])
  })

  it('does not evaluate result accessors or return transport exception details', async () => {
    const h = harness()
    const getter = vi.fn(() => 'SYNTHETIC_SECRET')
    const raw = Object.defineProperty({ ...SUCCESS }, 'message', { enumerable: true, get: getter })
    h.send.mockResolvedValueOnce(raw)
    expect(await h.manager.sendMessage(INPUT)).toEqual(FAILURE)
    expect(getter).not.toHaveBeenCalled()
    h.send.mockRejectedValueOnce(new Error('SYNTHETIC_SECRET'))
    expect(await h.manager.sendMessage(INPUT)).toEqual(FAILURE)
    h.send.mockImplementationOnce(() => { throw new Error('SYNTHETIC_SECRET') })
    expect(await h.manager.sendMessage(INPUT)).toEqual(FAILURE)
  })

  it('fails safely when no message transport has been configured', async () => {
    const manager = new DouyuTaskManager({ load: () => undefined, save: vi.fn(), run: vi.fn() })
    managers.push(manager)
    restore(manager)
    expect(await manager.sendMessage(INPUT)).toEqual(FAILURE)
  })
})
