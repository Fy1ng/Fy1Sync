import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateDouyuTask, DouyuAccountOperationContext, DouyuMessageInput, DouyuMessageOutcome,
  DouyuTaskDefinition, DouyuTaskOutcome, DouyuTaskStorage,
} from '../server/douyu/types'
import { DouyuTaskManager } from './douyuTasks'

// Synthetic, local queue tests. No networking, GUI or account credentials.
const ACCOUNT_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOREGROUND = { foreground: true, locked: false, suspended: false }
const BACKGROUND = { ...FOREGROUND, foreground: false }
const SIGN: CreateDouyuTask = { accountId: 'default', room: '100', kind: 'room-sign', policy: 'foreground', repeatMinutes: null }
const MESSAGE: DouyuMessageInput = { accountId: 'default', room: '100', text: 'SYNTHETIC_MESSAGE', color: 0 }
const SIGN_SUCCESS: DouyuTaskOutcome = { status: 'succeeded', message: '签到完成' }
const MESSAGE_SUCCESS: DouyuMessageOutcome = { status: 'succeeded', message: '发送完成', nextAllowedAt: null }
const VALUE = { businessOnly: 'SYNTHETIC_PRIVATE_RESULT' }
const managers: DouyuTaskManager[] = []
const scope = (overrides: Partial<DouyuAccountOperationContext> = {}): DouyuAccountOperationContext => ({ accountId: 'default', originRoom: '100', rooms: ['200', '300'], ...overrides })
const freshSignal = () => new AbortController().signal

interface Attempt<T> {
  signal: AbortSignal
  resolve: (result: T) => void
  reject: (error: unknown) => void
}

function harness(initial?: DouyuTaskStorage) {
  let saved = structuredClone(initial)
  let serial = 0
  const operations: Attempt<typeof VALUE>[] = []
  const signs: Attempt<DouyuTaskOutcome>[] = []
  const messages: Attempt<DouyuMessageOutcome>[] = []
  const save = vi.fn((data: DouyuTaskStorage) => { saved = structuredClone(data) })
  const run = vi.fn((_input: DouyuTaskDefinition, signal: AbortSignal) => new Promise<DouyuTaskOutcome>((resolve, reject) => { signs.push({ signal, resolve, reject }) }))
  const send = vi.fn((_input: DouyuMessageInput, signal: AbortSignal) => new Promise<DouyuMessageOutcome>((resolve, reject) => { messages.push({ signal, resolve, reject }) }))
  const produce = vi.fn((signal: AbortSignal) => new Promise<typeof VALUE>((resolve, reject) => { operations.push({ signal, resolve, reject }) }))
  const manager = new DouyuTaskManager({ load: () => saved, save, run, sendMessage: send,
    id: () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}` })
  managers.push(manager)
  restore(manager)
  return { manager, operations, signs, messages, save, run, send, produce, saved: () => structuredClone(saved) }
}

function restore(manager: DouyuTaskManager) {
  manager.setActiveAccount('default')
  manager.setRoom('100')
  manager.setRuntime(FOREGROUND)
}
function add(h: ReturnType<typeof harness>, overrides: Partial<CreateDouyuTask> = {}) {
  return h.manager.create({ ...SIGN, ...overrides }).tasks.at(-1)!.id
}
function addLoop(h: ReturnType<typeof harness>) {
  return add(h, { kind: 'message-loop', message: { text: 'SYNTHETIC_LOOP', colors: [0], intervalSeconds: 60, initialDelaySeconds: 0, maxRuns: 1 } })
}
async function flush() { for (let index = 0; index < 16; index++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('confirmed account operations share the single write lane', () => {
  it('runs once, returns the generic result to the business caller and creates no task', async () => {
    const h = harness()
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    expect(h.produce).not.toHaveBeenCalled()
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    expect(h.produce.mock.calls[0]![0]).toBeInstanceOf(AbortSignal)
    expect(h.manager.snapshot()).toMatchObject({ tasks: [], retainedRooms: [] })
    h.operations[0]!.resolve(VALUE)
    const result = await pending
    expect(result).toEqual({ status: 'completed', value: VALUE })
    if (result.status === 'completed') expect(result.value).toBe(VALUE)
    expect(h.save).not.toHaveBeenCalled()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(h.produce).toHaveBeenCalledOnce()
  })

  it.each(['sign', 'loop'] as const)('waits behind a %s flight and runs before the next queued sign', async kind => {
    const h = harness()
    const first = kind === 'sign' ? add(h) : addLoop(h)
    const second = add(h, { kind: 'yuba-sign' })
    h.manager.start(first)
    h.manager.start(second)
    await flush()
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    await flush()
    expect(h.produce).not.toHaveBeenCalled()
    if (kind === 'sign') h.signs[0]!.resolve(SIGN_SUCCESS)
    else h.messages[0]!.resolve(MESSAGE_SUCCESS)
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    expect(h.manager.snapshot().tasks.find(task => task.id === second)?.status).toBe('queued')
    h.operations[0]!.resolve(VALUE)
    expect(await pending).toMatchObject({ status: 'completed' })
    await flush()
    expect(h.manager.snapshot().tasks.find(task => task.id === second)?.status).toBe('running')
    expect(h.run).toHaveBeenCalledTimes(kind === 'sign' ? 2 : 1)
  })

  it('holds sign and loop tasks until an active operation completes', async () => {
    const h = harness()
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    const sign = add(h)
    const loop = addLoop(h)
    h.manager.start(sign)
    h.manager.start(loop)
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    expect(h.run).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    h.operations[0]!.resolve(VALUE)
    await pending
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.send).not.toHaveBeenCalled()
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
  })

  it.each(['queued', 'running'] as const)('returns busy behind an existing %s manual immediate', async phase => {
    const h = harness()
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const message = h.manager.sendMessage(MESSAGE)
    await flush()
    const signal = freshSignal()
    const listen = vi.spyOn(signal, 'addEventListener')
    expect(await h.manager.runAccountOperation(scope(), h.produce, signal)).toEqual({ status: 'busy' })
    expect(listen).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
    if (phase === 'queued') { h.signs[0]!.resolve(SIGN_SUCCESS); await flush() }
    h.messages[0]!.resolve(MESSAGE_SUCCESS)
    await message
  })

  it.each(['queued', 'running'] as const)('shares the one-immediate limit while an operation is %s', async phase => {
    const h = harness()
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    await flush()
    expect(await h.manager.runAccountOperation(scope(), h.produce, freshSignal())).toEqual({ status: 'busy' })
    expect(await h.manager.sendMessage(MESSAGE)).toMatchObject({ status: 'failed', message: '已有一条手动弹幕正在发送或等待, 请等待当前请求结束' })
    expect(h.send).not.toHaveBeenCalled()
    if (phase === 'queued') { h.signs[0]!.resolve(SIGN_SUCCESS); await flush() }
    expect(h.produce).toHaveBeenCalledOnce()
    h.operations[0]!.resolve(VALUE)
    await pending
  })

  it('supports no origin room and never auto-retains its explicitly selected targets', async () => {
    const h = harness()
    h.manager.setRoom(null)
    const pending = h.manager.runAccountOperation(scope({ originRoom: null }), h.produce, freshSignal())
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    expect(h.manager.snapshot()).toMatchObject({ currentRoom: null, retainedRooms: [] })
    h.operations[0]!.resolve(VALUE)
    expect(await pending).toMatchObject({ status: 'completed' })
    expect(h.save).not.toHaveBeenCalled()
  })

  it('cancels a null-origin operation when a room is entered, even a selected target', async () => {
    const h = harness()
    h.manager.setRoom(null)
    const pending = h.manager.runAccountOperation(scope({ originRoom: null }), h.produce, freshSignal())
    await flush()
    h.manager.setRoom('200')
    expect(await pending).toEqual({ status: 'cancelled', started: true })
    expect(h.operations[0]!.signal.aborted).toBe(true)
  })
})

describe('lifecycle gates and finite operation scope', () => {
  it.each(['account', 'origin', 'null-origin', 'background', 'locked', 'suspended'] as const)('returns unavailable for initial %s mismatch', async kind => {
    const h = harness()
    const context = scope()
    if (kind === 'account') context.accountId = ACCOUNT_B
    if (kind === 'origin') context.originRoom = '200'
    if (kind === 'null-origin') context.originRoom = null
    if (kind === 'background') h.manager.setRuntime(BACKGROUND)
    if (kind === 'locked') h.manager.setRuntime({ ...FOREGROUND, locked: true })
    if (kind === 'suspended') h.manager.setRuntime({ ...FOREGROUND, suspended: true })
    expect(await h.manager.runAccountOperation(context, h.produce, freshSignal())).toEqual({ status: 'unavailable' })
    restore(h.manager)
    await flush()
    expect(h.produce).not.toHaveBeenCalled()
  })

  const changes = ['account', 'no-account', 'credentials', 'remove-account', 'selected-room', 'other-room', 'disconnect',
    'close-target', 'close-origin', 'unretain-target', 'background', 'locked', 'suspended', 'dispose'] as const
  it.each(changes.flatMap(change => (['queued', 'running'] as const).map(phase => ({ change, phase }))))
  ('cancels a $phase operation on $change and never resumes it', async ({ change, phase }) => {
    const h = harness()
    h.manager.retainRoom('200', true)
    h.manager.retainRoom('100', true)
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    await flush()
    const cancel = {
      account: () => h.manager.setActiveAccount(ACCOUNT_B),
      'no-account': () => h.manager.setActiveAccount(null),
      credentials: () => h.manager.pauseAccount('default'),
      'remove-account': () => h.manager.removeAccount('default'),
      'selected-room': () => h.manager.setRoom('200'),
      'other-room': () => h.manager.setRoom('400'),
      disconnect: () => h.manager.setRoom(null),
      'close-target': () => h.manager.closeRoom('200'),
      'close-origin': () => h.manager.closeRoom('100'),
      'unretain-target': () => h.manager.retainRoom('200', false),
      background: () => h.manager.setRuntime(BACKGROUND),
      locked: () => h.manager.setRuntime({ ...FOREGROUND, locked: true }),
      suspended: () => h.manager.setRuntime({ ...FOREGROUND, suspended: true }),
      dispose: () => h.manager.dispose(),
    }
    cancel[change]()
    const result = await pending
    expect(result).toEqual({ status: 'cancelled', started: phase === 'running' })
    if (phase === 'running') expect(h.operations[0]!.signal.aborted).toBe(true)
    restore(h.manager)
    if (phase === 'running') h.operations[0]!.resolve(VALUE)
    else h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(h.produce).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
    expect(await pending).toEqual(result)
  })

  it('ignores unrelated account and room closures and allows unretaining the current room', async () => {
    const h = harness()
    h.manager.retainRoom('100', true)
    h.manager.retainRoom('400', true)
    const pending = h.manager.runAccountOperation(scope({ rooms: ['100', '200'] }), h.produce, freshSignal())
    await flush()
    h.manager.setActiveAccount('default')
    h.manager.setRoom('100')
    h.manager.pauseAccount(ACCOUNT_B)
    h.manager.removeAccount(ACCOUNT_B)
    h.manager.closeRoom('400')
    h.manager.retainRoom('100', false)
    h.manager.retainRoom('300', true)
    h.manager.retainRoom('300', false)
    expect(h.operations[0]!.signal.aborted).toBe(false)
    h.operations[0]!.resolve(VALUE)
    expect(await pending).toMatchObject({ status: 'completed' })
  })

  it.each((['remove-account', 'close-target', 'unretain-target'] as const)
    .flatMap(kind => (['queued', 'running'] as const).map(phase => ({ kind, phase }))))
  ('cancels a $phase operation before a failing $kind save and never restores it', async ({ kind, phase }) => {
    const h = harness()
    add(h, { room: '200' })
    h.manager.retainRoom('200', true)
    if (phase === 'queued') { h.manager.start(add(h)); await flush() }
    const oldStorage = h.saved()
    const signal = freshSignal()
    const removeListener = vi.spyOn(signal, 'removeEventListener')
    const pending = h.manager.runAccountOperation(scope(), h.produce, signal)
    await flush()
    h.save.mockImplementationOnce(() => {
      expect(removeListener).toHaveBeenCalledOnce()
      if (phase === 'running') expect(h.operations[0]!.signal.aborted).toBe(true)
      else expect(h.produce).not.toHaveBeenCalled()
      throw new Error('SYNTHETIC_PRIVATE_STORAGE_ERROR')
    })
    const change = kind === 'remove-account' ? () => h.manager.removeAccount('default')
      : kind === 'close-target' ? () => h.manager.closeRoom('200') : () => h.manager.retainRoom('200', false)
    expect(change).toThrow(expect.objectContaining({ code: 'storage-failed' }))
    expect(await pending).toEqual({ status: 'cancelled', started: phase === 'running' })
    expect(h.saved()).toEqual(oldStorage)
    if (phase === 'running') {
      expect(await h.manager.runAccountOperation(scope(), h.produce, freshSignal())).toEqual({ status: 'busy' })
      h.operations[0]!.resolve(VALUE)
    } else h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.produce).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
    expect(JSON.stringify(h.manager.snapshot())).not.toContain('SYNTHETIC_PRIVATE')
  })

  it.each([1, 2])('rechecks after observer publication %s before invoking the producer', async stopAt => {
    const h = harness()
    let armed = false
    let published = 0
    h.manager.subscribe(() => {
      if (armed && ++published === stopAt) {
        armed = false
        h.manager.closeRoom('300')
      }
    })
    armed = true
    const pending = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    await flush()
    expect(await pending).toEqual({ status: 'cancelled', started: false })
    expect(h.produce).not.toHaveBeenCalled()
    expect(h.manager.snapshot().tasks).toEqual([])
  })
})

describe('abort, cleanup and late producer settlements', () => {
  it('returns already-aborted without registering a listener or occupying the queue', async () => {
    const h = harness()
    const controller = new AbortController()
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT'))
    const listen = vi.spyOn(controller.signal, 'addEventListener')
    expect(await h.manager.runAccountOperation(scope(), h.produce, controller.signal)).toEqual({ status: 'cancelled', started: false })
    expect(listen).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
    h.send.mockResolvedValueOnce(MESSAGE_SUCCESS)
    expect(await h.manager.sendMessage(MESSAGE)).toEqual(MESSAGE_SUCCESS)
  })

  it('cancels an operation queued behind a sign without cancelling the sign, then accepts one replacement', async () => {
    const h = harness()
    h.manager.start(add(h))
    await flush()
    const controller = new AbortController()
    const pending = h.manager.runAccountOperation(scope(), h.produce, controller.signal)
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled', started: false })
    expect(h.signs[0]!.signal.aborted).toBe(false)
    const replacement = h.manager.runAccountOperation(scope(), h.produce, freshSignal())
    await flush()
    expect(h.produce).not.toHaveBeenCalled()
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    h.operations[0]!.resolve(VALUE)
    expect(await replacement).toMatchObject({ status: 'completed' })
  })

  it('cancels in the reservation microtask before the producer can run', async () => {
    const h = harness()
    const controller = new AbortController()
    const pending = h.manager.runAccountOperation(scope(), h.produce, controller.signal)
    controller.abort()
    expect(await pending).toEqual({ status: 'cancelled', started: false })
    await flush()
    expect(h.produce).not.toHaveBeenCalled()
    h.manager.start(add(h))
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('keeps an aborted producer in the lane until its late %s', async settle => {
    const h = harness()
    const controller = new AbortController()
    const pending = h.manager.runAccountOperation(scope(), h.produce, controller.signal)
    await flush()
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT'))
    const cancelled = await pending
    expect(cancelled).toEqual({ status: 'cancelled', started: true })
    expect(h.operations[0]!.signal.aborted).toBe(true)
    const sign = add(h)
    const loop = addLoop(h)
    h.manager.start(sign)
    h.manager.start(loop)
    expect(await h.manager.runAccountOperation(scope(), h.produce, freshSignal())).toEqual({ status: 'busy' })
    expect(await h.manager.sendMessage(MESSAGE)).toMatchObject({ status: 'failed', message: expect.stringContaining('已有一条') })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.run).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    if (settle === 'resolve') h.operations[0]!.resolve(VALUE)
    else h.operations[0]!.reject(new Error('SYNTHETIC_PRIVATE_PRODUCER_ERROR'))
    await flush()
    expect(h.run).toHaveBeenCalledOnce()
    expect(h.send).not.toHaveBeenCalled()
    h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(h.send).toHaveBeenCalledOnce()
    expect(await pending).toEqual(cancelled)
    expect(h.produce).toHaveBeenCalledOnce()
    expect(JSON.stringify(h.manager.snapshot())).not.toContain('SYNTHETIC_PRIVATE')
  })

  it.each(['complete', 'reject', 'external', 'lifecycle', 'queued'] as const)('removes the external abort listener on %s settlement', async mode => {
    const h = harness()
    if (mode === 'queued') { h.manager.start(add(h)); await flush() }
    const controller = new AbortController()
    const listen = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = h.manager.runAccountOperation(scope(), h.produce, controller.signal)
    await flush()
    expect(listen).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function), { once: true })
    const listener = listen.mock.calls[0]![1]
    if (mode === 'complete') h.operations[0]!.resolve(VALUE)
    if (mode === 'reject') h.operations[0]!.reject(new Error('SYNTHETIC_PRIVATE_PRODUCER_ERROR'))
    if (mode === 'external' || mode === 'queued') controller.abort()
    if (mode === 'lifecycle') h.manager.pauseAccount('default')
    const result = await pending
    expect(remove).toHaveBeenCalledExactlyOnceWith('abort', listener)
    if (mode === 'reject') expect(result).toEqual({ status: 'failed' })
    if (mode === 'complete' || mode === 'reject') {
      controller.abort()
      expect(h.operations[0]!.signal.aborted).toBe(false)
    } else if (mode !== 'queued') h.operations[0]!.resolve(VALUE)
    else h.signs[0]!.resolve(SIGN_SUCCESS)
    await flush()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('sanitizes synchronous producer exceptions and releases the lane', async () => {
    const h = harness()
    const throwing = vi.fn((): Promise<never> => { throw new Error('SYNTHETIC_PRIVATE_PRODUCER_ERROR') })
    expect(await h.manager.runAccountOperation(scope(), throwing, freshSignal())).toEqual({ status: 'failed' })
    h.send.mockResolvedValueOnce(MESSAGE_SUCCESS)
    expect(await h.manager.sendMessage(MESSAGE)).toEqual(MESSAGE_SUCCESS)
    expect(throwing).toHaveBeenCalledOnce()
  })

  it('reports started=true when the producer synchronously triggers a cancellation', async () => {
    const h = harness()
    const produce = vi.fn(async () => { h.manager.pauseAccount('default'); return VALUE })
    expect(await h.manager.runAccountOperation(scope(), produce, freshSignal())).toEqual({ status: 'cancelled', started: true })
    await flush()
    expect(produce).toHaveBeenCalledOnce()
  })
})

describe('operation input isolation and nonpersistence', () => {
  const invalid: unknown[] = [
    null, [], {}, new Date(), Object.assign(Object.create({ inherited: true }), scope()),
    { ...scope(), extra: true }, { ...scope(), [Symbol('extra')]: true },
    { accountId: 'default', rooms: ['200'] }, { ...scope(), accountId: '../outside' }, { ...scope(), accountId: '' },
    { ...scope(), originRoom: undefined }, { ...scope(), originRoom: 100 }, { ...scope(), originRoom: '0100' },
    { ...scope(), originRoom: 'https://www.douyu.com/100' }, { ...scope(), rooms: null },
    { ...scope(), rooms: [] }, { ...scope(), rooms: ['200', '200'] }, { ...scope(), rooms: new Array(1) },
    { ...scope(), rooms: Array.from({ length: 65 }, (_, index) => String(index + 1)) },
    { ...scope(), rooms: ['0'] }, { ...scope(), rooms: ['0200'] }, { ...scope(), rooms: [200] },
    { ...scope(), rooms: ['1234567890123'] }, { ...scope(), rooms: ['200 ', '300'] },
    { ...scope(), rooms: Object.assign(['200'], { extra: true }) },
    { ...scope(), rooms: Object.assign(['200'], { [Symbol('extra')]: true }) },
    { ...scope(), rooms: Object.setPrototypeOf(['200'], Object.create(Array.prototype)) },
  ]
  it.each(invalid)('rejects malformed scope before publishing, saving or producing %#', async raw => {
    const h = harness()
    const observer = vi.fn()
    h.manager.subscribe(observer)
    observer.mockClear()
    await expect(h.manager.runAccountOperation(raw as DouyuAccountOperationContext, h.produce, freshSignal())).rejects.toMatchObject({ code: 'invalid-arguments' })
    await flush()
    expect(observer).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })

  it('refuses scope and array accessors without invoking them', async () => {
    const h = harness()
    const getter = vi.fn(() => 'SYNTHETIC_PRIVATE_GETTER')
    const contexts = [
      Object.defineProperty(scope(), 'accountId', { get: getter }),
      Object.defineProperty(scope(), 'originRoom', { get: getter }),
      Object.defineProperty(scope(), 'rooms', { get: getter }),
      scope({ rooms: Object.defineProperty(['200'], '0', { get: getter }) }),
    ]
    for (const context of contexts) await expect(h.manager.runAccountOperation(context, h.produce, freshSignal())).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(getter).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}, 'producer'])('rejects a nonfunction producer %#', async run => {
    const h = harness()
    await expect(h.manager.runAccountOperation(scope(), run as typeof h.produce, freshSignal())).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(h.save).not.toHaveBeenCalled()
    expect(h.produce).not.toHaveBeenCalled()
  })

  it('preserves disposed behavior', async () => {
    const h = harness()
    h.manager.dispose()
    await expect(h.manager.runAccountOperation(scope(), h.produce, freshSignal())).rejects.toMatchObject({ code: 'disposed' })
  })

  it('accepts a plain null-prototype scope and 64 distinct canonical rooms while normalizing a UUID', async () => {
    const h = harness()
    h.manager.setActiveAccount(ACCOUNT_B)
    const context = Object.assign(Object.create(null), scope({ accountId: ACCOUNT_B.toUpperCase(), rooms: Array.from({ length: 64 }, (_, index) => String(index + 1)) })) as DouyuAccountOperationContext
    const pending = h.manager.runAccountOperation(context, h.produce, freshSignal())
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    h.operations[0]!.resolve(VALUE)
    expect(await pending).toMatchObject({ status: 'completed' })
  })

  it('copies all scope fields and nested room entries before dispatch', async () => {
    const h = harness()
    const context = scope()
    const rooms = context.rooms
    const pending = h.manager.runAccountOperation(context, h.produce, freshSignal())
    context.accountId = ACCOUNT_B
    context.originRoom = '400'
    rooms[0] = '400'
    context.rooms = ['500']
    await flush()
    expect(h.produce).toHaveBeenCalledOnce()
    h.manager.closeRoom('400')
    expect(h.operations[0]!.signal.aborted).toBe(false)
    h.manager.closeRoom('200')
    expect(h.operations[0]!.signal.aborted).toBe(true)
    expect(await pending).toEqual({ status: 'cancelled', started: true })
  })

  it('does not persist or publish operation scope, callback or generic result', async () => {
    const h = harness()
    add(h)
    const before = h.saved()
    const saves = h.save.mock.calls.length
    const snapshots: unknown[] = []
    h.manager.subscribe(snapshot => snapshots.push(snapshot))
    const pending = h.manager.runAccountOperation(scope({ rooms: ['543210987', '765432109'] }), h.produce, freshSignal())
    await flush()
    expect(h.saved()).toEqual(before)
    expect(h.save).toHaveBeenCalledTimes(saves)
    h.manager.retainRoom('100', true)
    const getter = vi.fn(() => 'SYNTHETIC_PRIVATE_GETTER')
    const result = Object.defineProperty({ ...VALUE }, 'businessGetter', { enumerable: true, get: getter })
    h.operations[0]!.resolve(result)
    const completion = await pending
    if (completion.status === 'completed') expect(completion.value).toBe(result)
    else expect.fail('Expected completion')
    expect(getter).not.toHaveBeenCalled()
    expect(JSON.stringify([h.save.mock.calls, snapshots, h.manager.snapshot()])).not.toMatch(/SYNTHETIC_PRIVATE|543210987|765432109|originRoom|operation/)
    const restored = harness(h.saved())
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(restored.produce).not.toHaveBeenCalled()
    expect(restored.run).not.toHaveBeenCalled()
    expect(restored.send).not.toHaveBeenCalled()
  })
})
