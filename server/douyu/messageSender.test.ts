import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from '../config'
import { encodeFrame, escapeStt, serializeStt } from '../danmaku/douyuProtocol'
import {
  DouyuMessageSender, type DouyuMessageSenderDependencies, type DouyuMessageSocket, type MessageSocketEvent,
} from './messageSender'
import { parseMessagePayload, type GatewayMessage, MAX_BUFFER_BYTES } from './messageProtocol'
import type { DouyuMessageInput } from './types'
import { DeliveryTracker } from '../danmaku/deliveryTracker'

// Exercise the default worker bridge without permitting a real network worker.
const workerFixture = vi.hoisted(() => ({ make: vi.fn<(source: string, options: unknown) => object>() }))
vi.mock('node:worker_threads', () => ({ Worker: class {
  constructor(source: string, options: unknown) { return workerFixture.make(source, options) }
} }))

const BASE = 1_700_000_000_000
const cookie = `acf_uid=42; acf_did=${'1'.repeat(32)}; acf_username=fixture-user; acf_auth_wl=fixture-auth; private=unused-value`
const input: DouyuMessageInput = { accountId: 'account-one', room: '6979222', text: 'fixture-message', color: 0 }
const keyPayload = { error: 0, data: { rand_str: 'fixture-challenge', enc_time: 1, cpp: {
  danmu: { key: 'fixture-login-key', key_ver: '1.0' }, heartbeat: { key: 'fixture-heartbeat-key', key_ver: '1.1' },
} } }
const gateway = { error: 0, data: { wss: [{ domain: 'wsproxy.douyu.com', port: 6671 }] } }
const proxy = resolveConfig({}).proxy
const signal = () => new AbortController().signal
const senders: DouyuMessageSender[] = []
type Fields = Record<string, string | number>
type Listener = (event: MessageSocketEvent) => void
const paletteList = (rows: Fields[]) => rows.map(row => `${escapeStt(serializeStt(row))}/`).join('')

// Synthetic WS events only. No live endpoint, account or browser profile is used.
class FakeSocket implements DouyuMessageSocket {
  readyState = 0
  binaryType = ''
  readonly listeners = new Map<string, Set<Listener>>()
  readonly sent: GatewayMessage[] = []
  readonly close = vi.fn(() => { this.readyState = 3; this.emit('close', {}) })
  readonly terminate = vi.fn(async () => {})
  constructor(private readonly onSend: (message: GatewayMessage, socket: FakeSocket) => void) {}
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, event: MessageSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  open(): void { this.readyState = 1; this.emit('open', {}) }
  send(data: Uint8Array): void {
    const frame = Buffer.from(data)
    expect(frame.readUInt16LE(8)).toBe(689)
    const fields = parseMessagePayload(frame.subarray(12, frame.length - 1).toString('utf8'))
    this.sent.push(fields)
    this.onSend(fields, this)
  }
  receive(fields: Fields): void { this.receiveMany([fields]) }
  receiveMany(fields: Fields[]): void { this.emit('message', { data: Buffer.concat(fields.map(value => encodeFrame(serializeStt(value), 690))) }) }
  get messages(): GatewayMessage[] { return this.sent.filter(message => message.type === 'chatmessage') }
  get listenerCount(): number { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) }
}
type Scenario = {
  login?: Fields
  rules?: Fields | false
  challenge?: Fields
  heartbeat?: Fields
  palette?: Fields[]
  paletteMessage?: Fields
  ack?: ((message: GatewayMessage, socket: FakeSocket) => void) | false
  onSend?: (message: GatewayMessage, socket: FakeSocket) => void
}

function setup(scenario: Scenario = {}, overrides: Partial<DouyuMessageSenderDependencies> = {}) {
  const sockets: FakeSocket[] = []
  const cookieHeader = vi.fn(async () => cookie)
  const request = vi.fn<typeof fetch>(async url => Response.json(String(url).includes('/getEncryption?') ? keyPayload : gateway))
  const createSocket = vi.fn((url: string) => {
    expect(url).toBe('wss://wsproxy.douyu.com:6671/')
    const socket = new FakeSocket((message, current) => {
      const receive = (fields: Fields) => queueMicrotask(() => current.receive(fields))
      if (message.type === 'loginreq') {
        receive({ type: 'loginres', userid: '42', username: 'fixture-user', npv: 0, ...scenario.login })
        if (scenario.rules !== false) receive({ type: 'initcl', uid: '42', cd: 1_000, maxl: 50, ...scenario.rules })
        if (scenario.palette !== undefined || scenario.paletteMessage !== undefined) receive({ type: 'fdm', list: paletteList(scenario.palette ?? []), ...scenario.paletteMessage })
      } else if (message.type === 'livreq') receive({ type: 'livres', nonce: 'fixture-challenge', its: '0', ...scenario.challenge })
      else if (message.type === 'keeplive') receive({ type: 'keeplive', tick: message.tick!, kd: '', nonce: 'fixture-next-nonce', its: '0', ...scenario.heartbeat })
      else if (message.type === 'chatmessage' && scenario.ack !== false) queueMicrotask(() => {
        if (typeof scenario.ack === 'function') scenario.ack(message, current)
        else current.receive({ type: 'chatres', res: 288, cst: message.cst!, uid: '42', rid: input.room, txt: message.content!, col: message.col!, cd: 1, len: 50 })
      })
      scenario.onSend?.(message, current)
    })
    sockets.push(socket)
    queueMicrotask(() => socket.open())
    return socket
  })
  const sender = new DouyuMessageSender({ cookieHeader, request, proxy, resolve: async () => ['8.8.8.8'], createSocket, ...overrides })
  senders.push(sender)
  return { sender, cookieHeader, request, createSocket, sockets }
}

async function flush(): Promise<void> { for (let count = 0; count < 100; count++) await Promise.resolve() }
function fakeClock(): void { vi.useFakeTimers(); vi.setSystemTime(BASE) }
function expectClean(socket: FakeSocket): void {
  expect(socket.close).toHaveBeenCalledOnce()
  expect(socket.terminate).toHaveBeenCalledOnce()
  expect(socket.listenerCount).toBe(0)
}
afterEach(async () => {
  for (const sender of senders.splice(0)) sender.dispose()
  await flush()
  vi.useRealTimers()
  vi.restoreAllMocks()
  workerFixture.make.mockReset()
})

describe('one-shot authenticated gateway handshake', () => {
  it('reads an authenticated balance without ever sending a chat message', async () => {
    fakeClock()
    const f = setup({ onSend: (message, socket) => {
      if (message.type === 'lsigreq') queueMicrotask(() => socket.receive({ type: 'memberinfores', uid: '42', gold: '600', silver: '20' }))
    } })
    const result = await f.sender.inspect('account-one', input.room, signal(), 'balance')
    expect(result).toMatchObject({ uid: '42', balance: { gold: 600, silver: 20 }, checkedAt: BASE })
    expect(f.sockets[0]!.messages).toHaveLength(0)
    expectClean(f.sockets[0]!)
    expect(JSON.stringify(result)).not.toMatch(/fixture-auth|fixture-user|private/)
  })

  it('uses only the authenticated target room badge for fan eligibility', async () => {
    fakeClock()
    const f = setup({ onSend: (message, socket) => {
      if (message.type === 'lsigreq') queueMicrotask(() => socket.receive({ type: 'blst', uid: '42', list: paletteList([{ rid: input.room, bl: 3 }]) }))
    } })
    const result = await f.sender.inspect('account-one', input.room, signal(), 'fan')
    expect(result).toMatchObject({ uid: '42', room: input.room, fanEligible: true, source: 'authenticated-blst-gbi' })
    expect(f.sockets[0]!.messages).toHaveLength(0)
    expectClean(f.sockets[0]!)
  })

  it('sends one normalized message only after identity, challenge, heartbeat and rules', async () => {
    fakeClock()
    const { sender, sockets, cookieHeader, request } = setup()
    const result = await sender.send({ ...input, text: ' 中文 /@ \\ 😀 ' }, signal())
    const socket = sockets[0]!
    expect(result).toEqual({ status: 'succeeded', message: '已收到斗鱼发送回执.', nextAllowedAt: BASE + 1_000 })
    expect(socket.sent.map(message => message.type)).toEqual(['loginreq', 'livreq', 'keeplive', 'lsigreq', 'chatmessage'])
    expect(socket.sent.find(message => message.type === 'lsigreq')?.sig).toBe('53d868321572b07050f69f66af6f3587')
    expect(socket.messages).toHaveLength(1)
    expect(socket.messages[0]).toMatchObject({ content: '中文 /@ \uff3c 😀', sender: '42', dy: '1'.repeat(32), col: '0', tts: '0', cst: String(BASE), nc: '0', ifs: '0', dat: '0' })
    expect(cookieHeader).toHaveBeenCalledTimes(3)
    for (const call of cookieHeader.mock.calls) expect(call).toEqual(['account-one', 'https://www.douyu.com/'])
    expect(request).toHaveBeenCalledTimes(2)
    expect(String(request.mock.calls[0]![0])).toBe(`https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=${'1'.repeat(32)}`)
    expect(String(request.mock.calls[1]![0])).toBe('https://www.douyu.com/lapi/live/gateway/web/6979222?isH5=1')
    for (const [, init] of request.mock.calls) {
      expect(init?.redirect).toBe('manual')
      expect(new Headers(init?.headers).has('cookie')).toBe(false)
      expect(JSON.stringify(init)).not.toMatch(/fixture-auth|fixture-user|unused-value/)
    }
    expect(JSON.stringify(result)).not.toMatch(/fixture|auth|userid|nonce|sig/)
    expectClean(socket)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each<Fields>([{ userid: '99' }, { userid: '0' }, { username: 'different-user' }, { username: '' }])('refuses an anonymous or incorrect account %#', async login => {
    const { sender, sockets } = setup({ login })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('重新登录') })
    expect(sockets[0]!.sent.map(message => message.type)).toEqual(['loginreq'])
    expectClean(sockets[0]!)
  })

  it('honors an explicit official eligibility requirement', async () => {
    const { sender, sockets } = setup({ login: { npv: '1' } })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('发言条件') })
    expect(sockets[0]!.messages).toEqual([])
  })

  it.each([2, 3])('rechecks the selected account before credential/message write %s', async changedCall => {
    let calls = 0
    const { sender, sockets } = setup({}, { cookieHeader: async () => ++calls >= changedCall ? cookie.replace('fixture-auth', 'changed-auth') : cookie })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('重新登录') })
    expect(sockets[0]!.messages).toEqual([])
    if (changedCall === 2) expect(sockets[0]!.sent).toEqual([])
  })

  it('requires actual matching initcl and heartbeat metadata instead of guessed rules', async () => {
    fakeClock()
    const { sender, sockets } = setup({ rules: false })
    const pending = sender.send(input, signal())
    await flush()
    expect(sockets[0]!.messages).toEqual([])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    expectClean(sockets[0]!)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ uid: '99' }, { uid: '' }])('does not borrow another account initcl %#', async rules => {
    fakeClock()
    const { sender, sockets } = setup({ rules })
    const pending = sender.send(input, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 'failed' })
    expect(sockets[0]!.messages).toEqual([])
  })

  it.each<Fields>([{ maxl: 0 }, { cd: -1 }, { fcd: -1 }, { cd: 'NaN' }, { maxl: 10_001 }])('refuses malformed server rules %#', async rules => {
    const { sender, sockets } = setup({ rules })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(sockets[0]!.messages).toEqual([])
    expectClean(sockets[0]!)
  })

  it.each<Fields>([{ its: '10001' }, { its: '-1' }, { nonce: '' }])('does not sign invalid challenges %#', async challenge => {
    const { sender, sockets } = setup({ challenge })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(sockets[0]!.messages).toEqual([])
  })

  it('refuses an unimplemented legacy heartbeat key', async () => {
    const { sender, sockets } = setup({ heartbeat: { kd: 'unexpected-legacy-key' } })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(sockets[0]!.messages).toEqual([])
  })

  it('processes a terminal error in the same packet before attempting a message', async () => {
    const { sender, sockets } = setup({ rules: false, onSend: (message, socket) => {
      if (message.type === 'lsigreq') queueMicrotask(() => socket.receiveMany([{ type: 'initcl', uid: '42', cd: 1_000, maxl: 50 }, { type: 'error', code: 59 }]))
    } })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('其它位置') })
    expect(sockets[0]!.messages).toEqual([])
  })
})

describe('structured limits and separately observed delivery', () => {
  it('returns the current server maximum without dispatching an overlong message', async () => {
    const { sender, sockets } = setup({ rules: { maxl: 3 } })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed', messageLimit: {
      localMaximumUnits: 500, serverMaximumUnits: 3, effectiveMaximumUnits: 3, receivedUnits: input.text.length,
    } })
    expect(sockets[0]!.messages).toHaveLength(0)
  })

  it('tracks a real send by UID and normalized text but never fabricates the room echo', async () => {
    fakeClock()
    const tracker = new DeliveryTracker({ now: () => Date.now(), id: () => 'delivery-fixture' })
    const { sender } = setup({}, { deliveryTracker: tracker })
    const result = await sender.send(input, signal())
    expect(result).toMatchObject({ status: 'succeeded', deliveryId: 'delivery-fixture', gatewayAccepted: true })
    expect(tracker.get(result.deliveryId!)!).toMatchObject({ gateway: 'accepted', roomEcho: 'pending' })
    tracker.observe({ id: 'broadcast-1', text: input.text, room: input.room, color: 0, level: 1,
      username: 'fixture', receivedAt: BASE + 1, system: false, sender: { uid: '42' } })
    expect(tracker.get(result.deliveryId!)!).toMatchObject({ gateway: 'accepted', roomEcho: 'observed' })
  })

  it('retains uncertainty after a dispatched connection is lost without creating another attempt', async () => {
    const tracker = new DeliveryTracker()
    const { sender, sockets } = setup({ ack: (_message, socket) => socket.emit('close', {}) }, { deliveryTracker: tracker })
    const result = await sender.send(input, signal())
    expect(result).toMatchObject({ status: 'waiting-user', gatewayAccepted: false })
    expect(tracker.get(result.deliveryId!)!).toMatchObject({ gateway: 'unknown', roomEcho: 'pending' })
    expect(sockets[0]!.messages).toHaveLength(1)
  })
})

describe('server length and persistent cooldown', () => {
  it('respects current maxl, with no truncation or guessed sending', async () => {
    const { sender, sockets } = setup({ rules: { maxl: 3 } })
    expect(await sender.send({ ...input, text: 'four' }, signal())).toMatchObject({ status: 'failed', message: expect.stringContaining('长度') })
    expect(sockets[0]!.messages).toEqual([])
  })
  it('waits for a reported first cooldown on the same connection', async () => {
    fakeClock()
    const { sender, sockets } = setup({ rules: { fcd: 1_000 } })
    const pending = sender.send(input, signal())
    await flush()
    expect(sockets[0]!.messages).toEqual([])
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets[0]!.messages).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toMatchObject({ status: 'succeeded', nextAllowedAt: BASE + 2_000 })
    expectClean(sockets[0]!)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('returns a long first cooldown instead of retaining a connection beyond the operation deadline', async () => {
    fakeClock()
    const { sender, sockets } = setup({ rules: { fcd: 60_000 } })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', nextAllowedAt: BASE + 60_000, deferredUntil: BASE + 60_000 })
    expect(sockets[0]!.messages).toEqual([])
    expectClean(sockets[0]!)
  })
  it('keeps chatres seconds-based cooldown when the previous connection is already closed', async () => {
    fakeClock()
    const { sender, sockets, request } = setup({ ack: (message, socket) => socket.receive({ type: 'chatres', res: 288, cst: message.cst!, cd: 3 }) })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'succeeded', nextAllowedAt: BASE + 3_000 })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', nextAllowedAt: BASE + 3_000, deferredUntil: BASE + 3_000 })
    expect(request).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await sender.send(input, signal())).toMatchObject({ status: 'succeeded', nextAllowedAt: BASE + 6_000 })
    expect(sockets).toHaveLength(2)
  })
  it('makes CST unique even when two sends have the same clock millisecond', async () => {
    fakeClock()
    const { sender, sockets } = setup({ rules: { cd: 0 }, ack: (message, socket) => socket.receive({ type: 'chatres', res: 288, cst: message.cst!, cd: 0 }) })
    await sender.send(input, signal())
    await sender.send(input, signal())
    expect(sockets.map(socket => socket.messages[0]!.cst)).toEqual([String(BASE), String(BASE + 1)])
  })
  it('rechecks newer rules received while account verification is pending', async () => {
    let calls = 0
    let release!: (value: string) => void
    const { sender, sockets } = setup({}, { cookieHeader: () => ++calls === 3 ? new Promise<string>(done => { release = done }) : Promise.resolve(cookie) })
    const pending = sender.send(input, signal())
    await flush()
    expect(calls).toBe(3)
    sockets[0]!.receive({ type: 'initcl', uid: '42', cd: 1_000, maxl: 1 })
    release(cookie)
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('长度') })
    expect(sockets[0]!.messages).toEqual([])
  })
})

describe('receipt matching and uncertain outcomes', () => {
  it.each([288, 356])('accepts only the confirmed code %s with CST or complete identity', async res => {
    const { sender } = setup({ ack: (message, socket) => socket.receive({ type: 'chatres', res, uid: '42', rid: '6979222', txt: message.content! }) })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'succeeded', message: '已收到斗鱼发送回执.' })
  })
  it.each<Fields>([{ cst: 'wrong' }, { uid: '99' }, { rid: '1' }, { txt: 'wrong-message' }, { sender: '99' }])('ignores a conflicting receipt before accepting the matching one %#', async conflict => {
    const { sender, sockets } = setup({ ack: (message, socket) => socket.receiveMany([
      { type: 'chatres', res: 288, cst: message.cst!, ...conflict },
      { type: 'chatres', res: 288, cst: message.cst! },
    ]) })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'succeeded' })
    expect(sockets[0]!.messages).toHaveLength(1)
  })
  it.each(['chatmsg', 'hischatmsg', 'unassociated'])('never treats %s as an attributable success', async type => {
    fakeClock()
    const { sender, sockets } = setup({ ack: (message, socket) => socket.receive(type === 'unassociated'
      ? { type: 'chatres', res: 288 }
      : { type, res: 288, uid: '42', rid: '6979222', txt: message.content!, cst: message.cst! }) })
    const pending = sender.send(input, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(sockets[0]!.messages).toHaveLength(1)
    expectClean(sockets[0]!)
  })
  it.each([2, 5, 6, 206, 208, 289, 290, 308, 391, 363, 0, 999])('never promotes failure or unknown code %s to success or leaks its body', async res => {
    const { sender, sockets } = setup({ ack: (message, socket) => socket.receive({ type: 'chatres', res, cst: message.cst!, cd: 2, msg: 'fixture-private-upstream-text', deferredUntil: BASE + 60_000 }) })
    const result = await sender.send(input, signal())
    expect(result.status).not.toBe('succeeded')
    expect(result).not.toHaveProperty('deferredUntil')
    if (res === 391) expect(result.message).toContain('官方账号验证')
    if ([0, 363, 999].includes(res)) expect(result.message).toContain('尚无法确认')
    expect(result.message).not.toContain('fixture-private')
    expect(sockets[0]!.messages).toHaveLength(1)
  })
  it('surfaces an unassociated verification requirement without claiming non-delivery', async () => {
    const { sender } = setup({ ack: (_message, socket) => socket.receive({ type: 'chatres', res: 391 }) })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringMatching(/官方账号验证.*尚无法确认/) })
  })
  it('treats disconnect after writing as unknown and does not reconnect', async () => {
    const { sender, sockets, createSocket } = setup({ ack: (_message, socket) => socket.emit('close', { code: 1006 }) })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('尚无法确认') })
    expect(createSocket).toHaveBeenCalledOnce()
    expect(sockets[0]!.messages).toHaveLength(1)
    expectClean(sockets[0]!)
  })
})

describe('network policy, input bounds and cancellation', () => {
  it.each([
    { text: '' }, { text: 'x'.repeat(501) }, { text: 'a\nb' }, { text: '\ud800' },
    { color: -1 }, { color: 7 }, { color: 1.5 }, { room: '001' }, { room: 'https://www.douyu.com/1' },
  ])('rejects invalid input before credential or network access %#', async change => {
    const { sender, cookieHeader, request } = setup()
    expect(await sender.send({ ...input, ...change }, signal())).toMatchObject({ status: 'failed' })
    expect(cookieHeader).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'not-an-ip'])('enforces guarded HTTP DNS despite permissive caller config: %s', async address => {
    const { sender, request, createSocket } = setup({}, { proxy: { ...proxy, hosts: ['*'], allowNonStandardPorts: true, allowNonLoopbackTargets: true }, resolve: async () => [address] })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(request).not.toHaveBeenCalled()
    expect(createSocket).not.toHaveBeenCalled()
  })
  it('validates WS DNS separately before any login credentials enter the socket', async () => {
    const { sender, request, createSocket } = setup({}, { resolve: async host => host === 'wsproxy.douyu.com' ? ['127.0.0.1'] : ['8.8.8.8'] })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(createSocket).not.toHaveBeenCalled()
  })
  it.each(['https://www.douyu.com/another', 'https://evil.example/', 'http://127.0.0.1/private'])('never follows a redirect to %s', async location => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location } }))
    const { sender, createSocket } = setup({}, { request })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(request).toHaveBeenCalledOnce()
    expect(createSocket).not.toHaveBeenCalled()
  })
  it('never follows an arbitrary gateway host returned by the server', async () => {
    const request = vi.fn<typeof fetch>(async url => Response.json(String(url).includes('getEncryption') ? keyPayload : { error: 0, data: { wss: [{ domain: '127.0.0.1', port: 6671 }] } }))
    const { sender, createSocket } = setup({}, { request })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(createSocket).not.toHaveBeenCalled()
  })
  it('cancels oversized HTTP bodies and refuses oversized incoming WS buffers', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65_537)) }, cancel })
    const first = setup({}, { request: async () => new Response(stream) })
    expect(await first.sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(cancel).toHaveBeenCalledOnce()
    const second = setup({ rules: false, onSend: (message, socket) => { if (message.type === 'lsigreq') socket.emit('message', { data: new Uint8Array(MAX_BUFFER_BYTES + 1) }) } })
    expect(await second.sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(second.sockets[0]!.messages).toEqual([])
    expectClean(second.sockets[0]!)
  })
  it('does nothing for a pre-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort(new Error('private-cancellation-reason'))
    const { sender, cookieHeader } = setup()
    expect(await sender.send(input, controller.signal)).toMatchObject({ status: 'failed', message: '发送已取消. 未发送弹幕.' })
    expect(cookieHeader).not.toHaveBeenCalled()
  })
  it('bounds a hung credential provider by the complete operation deadline', async () => {
    fakeClock()
    const { sender, request } = setup({}, { cookieHeader: () => new Promise(() => {}), proxy: { ...proxy, requestTimeoutMs: 999_999 } })
    const pending = sender.send(input, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('未发送') })
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not start a late request when DNS completes after cancellation', async () => {
    let release!: (value: string[]) => void
    const { sender, request, createSocket } = setup({}, { resolve: () => new Promise<string[]>(done => { release = done }) })
    const controller = new AbortController()
    const pending = sender.send(input, controller.signal)
    await flush()
    controller.abort()
    expect(await pending).toMatchObject({ status: 'failed' })
    release(['8.8.8.8'])
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(createSocket).not.toHaveBeenCalled()
  })
  it.each([false, true])('cancels and releases all socket resources with dispatched=%s', async dispatched => {
    fakeClock()
    const { sender, sockets } = setup({ ...(dispatched ? {} : { rules: false as const }), ack: false })
    const controller = new AbortController()
    const pending = sender.send(input, controller.signal)
    await flush()
    const socket = sockets[0]!
    expect(socket.messages.length).toBe(dispatched ? 1 : 0)
    controller.abort(new Error('private-upstream-secret'))
    const result = await pending
    expect(result.status).toBe(dispatched ? 'waiting-user' : 'failed')
    expect(result.message).toContain(dispatched ? '尚无法确认' : '未发送')
    expect(result.message).not.toContain('private')
    expect(result).not.toHaveProperty('deferredUntil')
    socket.receive({ type: 'chatres', res: 288, cst: socket.messages[0]?.cst ?? String(BASE) })
    await flush()
    expectClean(socket)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('permits no concurrent writes for one account and disposes pending work', async () => {
    const { sender, sockets, createSocket } = setup({ ack: false })
    const first = sender.send(input, signal())
    expect(await sender.send(input, signal())).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('已有一条') })
    await flush()
    sender.dispose()
    expect(await first).toMatchObject({ status: 'waiting-user' })
    expect(await sender.send(input, signal())).toMatchObject({ status: 'failed' })
    expect(createSocket).toHaveBeenCalledOnce()
    expectClean(sockets[0]!)
  })
})

describe('default native WebSocket worker bridge', () => {
  it.each([false, true])('releases the worker after completion/cancellation, cancel=%s', async cancel => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>
      terminate: ReturnType<typeof vi.fn>
    }
    const port = new EventEmitter() as EventEmitter & { postMessage: (message: unknown) => void }
    let stopped = false
    let nativeSocket: FakeSocket | null = null
    port.postMessage = message => queueMicrotask(() => { if (!stopped) worker.emit('message', message) })
    worker.postMessage = vi.fn((command: unknown) => queueMicrotask(() => { if (!stopped) port.emit('message', command) }))
    worker.terminate = vi.fn(async () => {
      stopped = true
      port.removeAllListeners()
      nativeSocket?.listeners.clear()
      worker.emit('exit', 0)
      return 0
    })
    workerFixture.make.mockImplementation((source, options) => {
      const settings = options as { workerData: { url: string; limit: number; runtimePath: string; addresses: string[] }; eval: boolean }
      expect(settings.eval).toBe(true)
      expect(settings.workerData.url).toBe('wss://wsproxy.douyu.com:6671/')
      expect(settings.workerData.runtimePath).toBe('/application/network-runtime.cjs')
      expect(settings.workerData.addresses).toEqual(['8.8.8.8'])
      const dispatcher = { destroy: vi.fn(async () => {}) }
      runInNewContext(source, {
        ArrayBuffer, Uint8Array, URL,
        require: (name: string) => {
          if (name === 'node:worker_threads') return { parentPort: port, workerData: settings.workerData }
          expect(name).toBe(settings.workerData.runtimePath)
          return { createPinnedDispatcher: (hostname: string, addresses: string[]) => {
            expect(hostname).toBe('wsproxy.douyu.com')
            expect(addresses).toEqual(['8.8.8.8'])
            return dispatcher
          } }
        },
        WebSocket: class extends FakeSocket {
          constructor(url: string, init: { dispatcher: unknown }) {
            expect(url).toBe(settings.workerData.url)
            expect(init.dispatcher).toBe(dispatcher)
            super((message, socket) => {
              const receive = (fields: Fields) => queueMicrotask(() => socket.receive(fields))
              if (message.type === 'loginreq') {
                receive({ type: 'loginres', userid: '42', username: 'fixture-user', npv: 0 })
                receive({ type: 'initcl', uid: '42', cd: 1_000, maxl: 50 })
              } else if (message.type === 'livreq') receive({ type: 'livres', nonce: 'fixture-challenge', its: '0' })
              else if (message.type === 'keeplive') receive({ type: 'keeplive', tick: message.tick!, kd: '', nonce: 'fixture-next', its: '0' })
              else if (message.type === 'chatmessage' && !cancel) receive({ type: 'chatres', res: 288, cst: message.cst!, cd: 1 })
            })
            nativeSocket = this
            queueMicrotask(() => this.open())
          }
          override receiveMany(fields: Fields[]): void {
            const buffer = Uint8Array.from(Buffer.concat(fields.map(value => encodeFrame(serializeStt(value), 690))))
            this.emit('message', { data: buffer.buffer })
          }
        },
      })
      return worker
    })
    const { sender } = setup({}, { createSocket: undefined, networkRuntimePath: '/application/network-runtime.cjs' })
    const controller = new AbortController()
    const pending = sender.send(input, controller.signal)
    await flush()
    if (cancel) controller.abort()
    expect(await pending).toMatchObject({ status: cancel ? 'waiting-user' : 'succeeded' })
    expect(workerFixture.make).toHaveBeenCalledOnce()
    expect(worker.postMessage.mock.calls.some(([message]) => (message as { type: string }).type === 'close')).toBe(true)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.eventNames()).toEqual([])
    expect(port.eventNames()).toEqual([])
  })
})

describe('authorized ordinary message colors', () => {
  it.each([1, 2, 3, 4, 5, 6])('sends the requested unlocked col=%s with the official fans flag', async color => {
    const { sender, sockets } = setup({ palette: [{ col: color, ul: 1, ubl: 21 }] })
    const result = await sender.send({ ...input, color }, signal())
    expect(result).toMatchObject({ status: 'succeeded' })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toHaveLength(1)
    expect(sockets[0]!.messages[0]).toMatchObject({ col: String(color), pe: '0', ifs: '1', nc: '0', dat: '0' })
  })
  it.each([0, 2])('does not infer color availability from an unconfirmed ul=%s', async ul => {
    const { sender, sockets } = setup({ palette: [{ col: 2, ul, ubl: 0 }] })
    const result = await sender.send({ ...input, color: 2 }, signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('颜色') })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toEqual([])
  })
  it('requires a fresh palette without changing the request to ordinary color zero', async () => {
    fakeClock()
    const { sender, sockets } = setup()
    const pending = sender.send({ ...input, color: 2 }, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    const result = await pending
    expect(result).toMatchObject({ status: 'failed' })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toEqual([])
  })
  it.each<Fields>([{ uid: '99' }, { userid: '99' }, { rid: '1' }, { roomid: '1' }])('does not borrow another account or room palette %#', async paletteMessage => {
    fakeClock()
    const { sender, sockets } = setup({ palette: [{ col: 2, ul: 1 }], paletteMessage })
    const pending = sender.send({ ...input, color: 2 }, signal())
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toMatchObject({ status: 'failed' })
    expect(sockets[0]!.messages).toEqual([])
  })
  it('does not retain an unlocked palette after closing its connection', async () => {
    fakeClock()
    const scenario: Scenario = {
      rules: { cd: 0 }, palette: [{ col: 2, ul: 1 }],
      ack: (message, socket) => socket.receive({ type: 'chatres', res: 288, cst: message.cst!, col: message.col!, cd: 0 }),
    }
    const { sender, sockets } = setup(scenario)
    expect(await sender.send({ ...input, color: 2 }, signal())).toMatchObject({ status: 'succeeded' })
    scenario.palette = []
    expect(await sender.send({ ...input, color: 2 }, signal())).toMatchObject({ status: 'waiting-user' })
    expect(sockets[0]!.messages).toHaveLength(1)
    expect(sockets[1]!.messages).toEqual([])
  })
  it.each([undefined, '0', '3', '7', 'invalid'])('stops after a receipt that does not confirm the requested color: %s', async col => {
    const { sender, sockets } = setup({ palette: [{ col: 2, ul: 1 }], ack: (message, socket) => socket.receive({
      type: 'chatres', res: 288, cst: message.cst!, cd: 2, ...(col === undefined ? {} : { col }),
    }) })
    const result = await sender.send({ ...input, color: 2 }, signal())
    expect(result).toMatchObject({ status: 'waiting-user', message: expect.stringContaining('未确认所选弹幕颜色') })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toHaveLength(1)
    expect(sockets[0]!.messages[0]!.col).toBe('2')
  })
  it('stops on an explicit color error without retrying in color zero', async () => {
    const { sender, sockets } = setup({ palette: [{ col: 2, ul: 1 }], ack: (message, socket) => socket.receive({ type: 'chatres', res: 308, cst: message.cst!, cd: 2 }) })
    const result = await sender.send({ ...input, color: 2 }, signal())
    expect(result).toMatchObject({ status: 'failed' })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages.map(message => message.col)).toEqual(['2'])
  })
  it('applies a palette revocation received during the final account check', async () => {
    let calls = 0
    let release!: (value: string) => void
    const { sender, sockets } = setup({ palette: [{ col: 2, ul: 1 }] }, {
      cookieHeader: () => ++calls === 3 ? new Promise<string>(done => { release = done }) : Promise.resolve(cookie),
    })
    const pending = sender.send({ ...input, color: 2 }, signal())
    await flush()
    expect(calls).toBe(3)
    sockets[0]!.receive({ type: 'fdm', list: paletteList([{ col: 2, ul: 0 }]) })
    release(cookie)
    const result = await pending
    expect(result).toMatchObject({ status: 'waiting-user' })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toEqual([])
  })
})

describe('known-unsent deferral is distinct from submitted outcomes', () => {
  it('does not attach deferral to a network-policy failure despite a recorded cooldown', async () => {
    fakeClock()
    const policy = { ...proxy }
    const { sender, sockets } = setup({}, { proxy: policy })
    await sender.send(input, signal())
    policy.enabled = false
    const result = await sender.send(input, signal())
    expect(result).toMatchObject({ status: 'failed', nextAllowedAt: BASE + 1_000 })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets).toHaveLength(1)
  })
  it('does not attach deferral to pre-cancellation despite a recorded cooldown', async () => {
    fakeClock()
    const { sender, sockets } = setup()
    await sender.send(input, signal())
    const controller = new AbortController()
    controller.abort()
    const result = await sender.send(input, controller.signal)
    expect(result).toMatchObject({ status: 'failed', nextAllowedAt: BASE + 1_000 })
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets).toHaveLength(1)
  })
  it.each(['cancelled', 'expired'])('does not return a %s deferral after resource cleanup', async reason => {
    fakeClock()
    let release!: () => void
    const { sender, sockets } = setup({ rules: { fcd: 60_000 }, onSend: (message, socket) => {
      if (message.type === 'loginreq') socket.terminate.mockImplementation(() => new Promise<void>(done => { release = done }))
    } })
    const controller = new AbortController()
    const pending = sender.send(input, controller.signal)
    await flush()
    expect(sockets[0]!.terminate).toHaveBeenCalledOnce()
    if (reason === 'cancelled') controller.abort()
    else vi.setSystemTime(BASE + 60_001)
    release()
    expect(await pending).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toEqual([])
  })
  it.each(['timeout', 'disconnect', '290'])('never defers an already submitted %s outcome', async reason => {
    fakeClock()
    const { sender, sockets } = setup({ ack: reason === 'timeout' ? false : (message, socket) => {
      if (reason === 'disconnect') socket.emit('close', { code: 1006 })
      else socket.receive({ type: 'chatres', res: 290, cst: message.cst!, cd: 20 })
    } })
    const pending = sender.send(input, signal())
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(15_000)
    const result = await pending
    expect(result.status).not.toBe('succeeded')
    expect(result).not.toHaveProperty('deferredUntil')
    expect(sockets[0]!.messages).toHaveLength(1)
    if (reason === '290') expect(result.nextAllowedAt).toBe(BASE + 20_000)
  })
})
