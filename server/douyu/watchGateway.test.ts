import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { resolveConfig } from '../config'
import { encodeFrame, serializeStt } from '../danmaku/douyuProtocol'
import type { DouyuMessageSocket, MessageSocketEvent } from './messageSender'
import { parseMessagePayload, signMessageGateway, messageSigningKeys, type GatewayMessage } from './messageProtocol'
import { DOUYU_WATCH_HEARTBEAT_MS, DouyuWatchGateway, DouyuWatchGatewayError, NativeWatchSocket, type DouyuWatchGatewayDependencies } from './watchGateway'
import pcReference from './fixtures/watch-kd-pc-vectors.json'

const workerFixture = vi.hoisted(() => ({ make: vi.fn<(source: string, options: unknown) => object>() }))
vi.mock('node:worker_threads', () => ({ Worker: class { constructor(source: string, options: unknown) { return workerFixture.make(source, options) } } }))

const BASE = 1_700_000_000_000
const cookie = `acf_uid=42; acf_did=${'1'.repeat(32)}; acf_username=fixture-user; acf_auth_wl=fixture-auth; private=unused-value`
const keyPayload = { error: 0, data: { rand_str: 'fixture-challenge', enc_time: 1, cpp: {
  danmu: { key: 'fixture-login-key', key_ver: '1.0' }, heartbeat: { key: 'fixture-heartbeat-key', key_ver: '1.1' },
} } }
const gatewayPayload = { error: 0, data: { wss: [{ domain: 'wsproxy.douyu.com', port: 6671 }] } }
const pcTemplate = readFileSync(new URL('./fixtures/watch-kd-pc-template.txt', import.meta.url), 'utf8')
const kdPayload = { error: 0, data: { room6979222: pcTemplate } }
type Fields = Record<string, string | number>
type Listener = (event: MessageSocketEvent) => void

class FakeSocket implements DouyuMessageSocket {
  readyState = 0
  readonly sent: GatewayMessage[] = []
  readonly listeners = new Map<string, Set<Listener>>()
  readonly close = vi.fn(() => { this.readyState = 3 })
  readonly terminate = vi.fn(async () => {})
  constructor(private readonly onSend: (message: GatewayMessage, socket: FakeSocket) => void) {}
  addEventListener(type: string, listener: Listener): void {
    const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group)
  }
  removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener) }
  emit(type: string, data: MessageSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(data) }
  open(): void { this.readyState = 1; this.emit('open', {}) }
  send(value: Uint8Array): void {
    const frame = Buffer.from(value)
    const message = parseMessagePayload(frame.subarray(12, frame.length - 1).toString('utf8'))
    this.sent.push(message); this.onSend(message, this)
  }
  receive(message: Fields): void { this.emit('message', { data: encodeFrame(serializeStt(message), 690) }) }
  get listenerCount(): number { return [...this.listeners.values()].reduce((count, group) => count + group.size, 0) }
}

type Scenario = { login?: Fields; kd?: string; kdSequence?: string[]; reply?: boolean; open?: boolean; challenge?: Fields }
const controllers: AbortController[] = []
async function flush(): Promise<void> { for (let index = 0; index < 80; index++) await Promise.resolve() }
function setup(scenario: Scenario = {}, overrides: Partial<DouyuWatchGatewayDependencies> = {}) {
  const controller = new AbortController(); controllers.push(controller)
  const sockets: FakeSocket[] = []
  let revision = 0
  const cookieHeader = vi.fn(async () => cookie)
  const request = vi.fn<typeof fetch>(async url => Response.json(String(url).includes('/getEncryption?') ? keyPayload
    : String(url).includes('/homeH5Enc?') ? kdPayload : gatewayPayload))
  const createSocket = vi.fn((url: string, addresses: readonly string[]) => {
    expect(url).toBe('wss://wsproxy.douyu.com:6671/'); expect(addresses).toEqual(['8.8.8.8'])
    const socket = new FakeSocket((message, current) => {
      const receive = (value: Fields) => queueMicrotask(() => current.receive(value))
      if (message.type === 'loginreq') receive({ type: 'loginres', userid: '42', username: 'fixture-user', ...scenario.login })
      if (message.type === 'livreq') receive({ type: 'livres', nonce: 'fixture-login-challenge', its: '0', ...scenario.challenge })
      if (message.type === 'keeplive' && scenario.reply !== false) {
        const kd = scenario.kdSequence?.[revision] ?? scenario.kd ?? ''
        receive({ type: 'keeplive', tick: message.tick!, kd, nonce: `fixture-next-${++revision}`, its: '0' })
      }
    })
    sockets.push(socket)
    if (scenario.open !== false) queueMicrotask(() => socket.open())
    return socket
  })
  const instance = new DouyuWatchGateway({ cookieHeader, request, proxy: resolveConfig({}).proxy, resolve: async () => ['8.8.8.8'], createSocket, ...overrides })
  const stats = vi.fn(() => ({ bytes: 900_000, cdn: 'tct-h5' }))
  const onHeartbeat = vi.fn()
  const outcome = instance.run('account-one', '6979222', controller.signal, stats, onHeartbeat).then(() => null, error => error as unknown)
  return { instance, controller, sockets, cookieHeader, request, createSocket, stats, onHeartbeat, outcome }
}
function fakeClock(): void { vi.useFakeTimers(); vi.setSystemTime(BASE) }
function expectClean(socket: FakeSocket): void { expect(socket.close).toHaveBeenCalledOnce(); expect(socket.terminate).toHaveBeenCalledOnce(); expect(socket.listenerCount).toBe(0) }
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  await flush(); vi.useRealTimers(); vi.restoreAllMocks(); workerFixture.make.mockReset()
})

describe('authenticated real-viewing gateway', () => {
  it('continues signed heartbeats, consumes each nonce and reports matching receipts', async () => {
    fakeClock()
    const f = setup(); await flush()
    expect(f.onHeartbeat).toHaveBeenCalledExactlyOnceWith(BASE)
    expect(f.sockets[0]!.sent.map(message => message.type)).toEqual(['loginreq', 'livreq', 'keeplive', 'lsigreq'])
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    const second = f.sockets[0]!.sent.filter(message => message.type === 'keeplive')[1]!
    expect(second).toMatchObject({ vbw: '900000', cdn: 'tct-h5', tick: String((BASE + DOUYU_WATCH_HEARTBEAT_MS) / 1000), kd: '' })
    expect(second.sig).toBe(signMessageGateway('heartbeat', messageSigningKeys(keyPayload), '6979222', '1'.repeat(32), Number(second.tick), { nonce: 'fixture-next-1', iterations: 0 }).sig)
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    const third = f.sockets[0]!.sent.filter(message => message.type === 'keeplive')[2]!
    expect(third.sig).toBe(signMessageGateway('heartbeat', messageSigningKeys(keyPayload), '6979222', '1'.repeat(32), Number(third.tick), { nonce: 'fixture-next-2', iterations: 0 }).sig)
    expect(f.onHeartbeat).toHaveBeenCalledTimes(3)
    f.controller.abort(); expect(await f.outcome).toMatchObject({ name: 'AbortError' }); expectClean(f.sockets[0]!)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not export cookies through HTTP requests, receipts, or error messages', async () => {
    const f = setup(); await flush()
    expect(f.request).toHaveBeenCalledTimes(2)
    for (const [url, init] of f.request.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/www\.douyu\.com\//)
      expect(init?.redirect).toBe('manual'); expect(new Headers(init?.headers).has('cookie')).toBe(false)
      expect(JSON.stringify(init)).not.toMatch(/fixture-auth|fixture-user|unused-value/)
    }
    f.sockets[0]!.emit('error', { data: 'fixture-auth upstream-raw-error' })
    const error = await f.outcome
    expect(error).toMatchObject({ code: 'network-error' }); expect(String(error)).not.toMatch(/fixture|upstream/)
    expect(f.onHeartbeat.mock.calls).toEqual([[expect.any(Number)]])
  })

  it.each<Fields>([{ userid: '99' }, { username: 'wrong-user' }, { is_illegal: '1' }])('rejects incorrect or prohibited login %#', async login => {
    const f = setup({ login }); expect(await f.outcome).toMatchObject({ code: 'login-required' })
    expect(f.sockets[0]!.sent.map(message => message.type)).toEqual(['loginreq']); expect(f.onHeartbeat).not.toHaveBeenCalled(); expectClean(f.sockets[0]!)
  })

  it('ends explicitly when the PC kd source template is unsupported', async () => {
    const f = setup({ kd: '0123456789abcdef' }, { request: async url => Response.json(String(url).includes('/getEncryption?') ? keyPayload
      : String(url).includes('/homeH5Enc?') ? { error: 0, data: { room6979222: 'unknown-function' } } : gatewayPayload) })
    expect(await f.outcome).toMatchObject({ code: 'protocol-unsupported' }); expect(f.onHeartbeat).not.toHaveBeenCalled()
    expect(f.sockets[0]!.sent.filter(message => message.type === 'keeplive')).toHaveLength(1); expectClean(f.sockets[0]!)
  })

  it('lazily loads the PC transform once and returns each processed kd with its separate nonce signature', async () => {
    fakeClock()
    const first = pcReference.vectors[0]!, second = pcReference.vectors[1]!
    const f = setup({ kdSequence: [first.inputHex, second.inputHex, ''] }); await flush()
    expect(f.request).toHaveBeenCalledTimes(3)
    expect(String(f.request.mock.calls[2]![0])).toBe('https://www.douyu.com/swf_api/homeH5Enc?rids=6979222')
    expect(f.request.mock.calls[2]![1]?.method).toBe('GET')
    expect(new Headers(f.request.mock.calls[2]![1]?.headers).has('cookie')).toBe(false)
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    const next = f.sockets[0]!.sent.filter(message => message.type === 'keeplive')[1]!
    expect(next.kd).toBe(first.outputHex)
    expect(next.sig).toBe(signMessageGateway('heartbeat', messageSigningKeys(keyPayload), '6979222', '1'.repeat(32), Number(next.tick), { nonce: 'fixture-next-1', iterations: 0 }).sig)
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    expect(f.sockets[0]!.sent.filter(message => message.type === 'keeplive')[2]!.kd).toBe(second.outputHex)
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    expect(f.sockets[0]!.sent.filter(message => message.type === 'keeplive')[3]!.kd).toBe('')
    expect(f.request).toHaveBeenCalledTimes(3)
    f.controller.abort(); expect(await f.outcome).toMatchObject({ name: 'AbortError' }); expectClean(f.sockets[0]!)
  })

  it('rejects a kd source mapped to another room', async () => {
    const f = setup({ kd: '0000000000000000' }, { request: async url => Response.json(String(url).includes('/getEncryption?') ? keyPayload
      : String(url).includes('/homeH5Enc?') ? { error: 0, data: { room9999: pcTemplate } } : gatewayPayload) })
    expect(await f.outcome).toMatchObject({ code: 'protocol-unsupported' }); expect(f.onHeartbeat).not.toHaveBeenCalled(); expectClean(f.sockets[0]!)
  })

  it('cancels a stalled lazy kd-source request without sending another heartbeat', async () => {
    const f = setup({ kd: '0000000000000000' }, { request: async url => String(url).includes('/homeH5Enc?') ? new Promise(() => {})
      : Response.json(String(url).includes('/getEncryption?') ? keyPayload : gatewayPayload) })
    await flush(); f.controller.abort()
    expect(await f.outcome).toMatchObject({ name: 'AbortError' }); expect(f.onHeartbeat).not.toHaveBeenCalled(); expectClean(f.sockets[0]!)
  })

  it('times out a stalled lazy kd-source request and rejects malformed kd before loading a source', async () => {
    fakeClock()
    const f = setup({ kd: '0000000000000000' }, { request: async url => String(url).includes('/homeH5Enc?') ? new Promise(() => {})
      : Response.json(String(url).includes('/getEncryption?') ? keyPayload : gatewayPayload) })
    await flush(); await vi.advanceTimersByTimeAsync(15_000)
    expect(await f.outcome).toMatchObject({ code: 'timeout' }); expect(f.onHeartbeat).not.toHaveBeenCalled(); expectClean(f.sockets[0]!)
    const malformed = setup({ kd: '00000000' })
    expect(await malformed.outcome).toMatchObject({ code: 'protocol-unsupported' }); expect(malformed.request).toHaveBeenCalledTimes(2)
  })

  it('signs an additional authenticated login challenge without duplicating receipt callbacks', async () => {
    const f = setup(); await flush()
    f.sockets[0]!.receive({ type: 'livres', nonce: 'fixture-renewal', its: '2' })
    await flush()
    expect(f.sockets[0]!.sent.filter(message => message.type === 'lsigreq')).toHaveLength(2)
    expect(f.onHeartbeat).toHaveBeenCalledOnce()
  })

  it('rejects a changed credential before another viewing heartbeat', async () => {
    fakeClock(); const f = setup(); await flush()
    f.cookieHeader.mockResolvedValue(cookie.replace('fixture-auth', 'changed-auth'))
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS)
    expect(await f.outcome).toMatchObject({ code: 'account-changed' })
    expect(f.sockets[0]!.sent.filter(message => message.type === 'keeplive')).toHaveLength(1); expectClean(f.sockets[0]!)
  })

  it('times out a credential provider that stalls after a healthy heartbeat', async () => {
    fakeClock()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    })
    const f = setup(); await flush()
    f.cookieHeader.mockImplementation(async () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(DOUYU_WATCH_HEARTBEAT_MS + 15_000)
    expect(await f.outcome).toMatchObject({ code: 'timeout' })
    expect(f.sockets[0]!.sent.filter(message => message.type === 'keeplive')).toHaveLength(1); expectClean(f.sockets[0]!)
  })

  it('ignores wrong-room and unmatched heartbeat acknowledgments, then times out', async () => {
    fakeClock(); const f = setup({ reply: false }); await flush()
    const tick = f.sockets[0]!.sent.find(message => message.type === 'keeplive')!.tick!
    f.sockets[0]!.receive({ type: 'keeplive', tick, rid: '9999' })
    f.sockets[0]!.receive({ type: 'keeplive', tick: '0' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await f.outcome).toMatchObject({ code: 'timeout' }); expect(f.onHeartbeat).not.toHaveBeenCalled(); expectClean(f.sockets[0]!)
  })

  it('bounds a socket that never opens and cancels a pending credential provider', async () => {
    fakeClock(); const f = setup({ open: false }); await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await f.outcome).toMatchObject({ code: 'timeout' }); expectClean(f.sockets[0]!)
    const second = setup({}, { cookieHeader: async () => new Promise(() => {}) })
    second.controller.abort(); expect(await second.outcome).toMatchObject({ name: 'AbortError' })
    expect(second.createSocket).not.toHaveBeenCalled()
  })

  it('bounds initialization and rejects missing login or denied network policy', async () => {
    fakeClock()
    const hung = setup({}, { request: async () => new Promise(() => {}) }); await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await hung.outcome).toMatchObject({ code: 'timeout' })
    expect(await setup({}, { cookieHeader: async () => '' }).outcome).toMatchObject({ code: 'login-required' })
    const denied = setup({}, { proxy: { ...resolveConfig({}).proxy, hosts: ['example.com'] } })
    expect(await denied.outcome).toMatchObject({ code: 'network-error' }); expect(denied.cookieHeader).not.toHaveBeenCalled()
  })

  it('rejects invalid DNS results and an untrusted gateway destination without creating a socket', async () => {
    const dns = setup({}, { resolve: async () => ['not-an-ip'] })
    expect(await dns.outcome).toMatchObject({ code: 'network-error' }); expect(dns.createSocket).not.toHaveBeenCalled()
    const foreign = setup({}, { request: async url => Response.json(String(url).includes('/getEncryption?') ? keyPayload : { error: 0, data: { wss: [{ domain: 'evil.invalid', port: 6671 }] } }) })
    expect(await foreign.outcome).toMatchObject({ code: 'protocol-unsupported' }); expect(foreign.createSocket).not.toHaveBeenCalled()
  })

  it('rejects fabricated or out-of-bound playback statistics before transmitting them', async () => {
    const f = setup(); f.stats.mockReturnValue({ bytes: -1, cdn: 'tct-h5' })
    expect(await f.outcome).toMatchObject({ code: 'invalid-arguments' })
    expect(f.sockets[0]!.sent.some(message => message.type === 'keeplive')).toBe(false)
  })
})

describe('viewing transport worker boundaries', () => {
  it('uses pinned DNS, rolling traffic quotas and prompt termination', async () => {
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 0) })
    let source = '', options: { workerData: Record<string, unknown> } | null = null
    workerFixture.make.mockImplementation((text, value) => { source = text; options = value as typeof options; return worker })
    const socket = new NativeWatchSocket('wss://wsproxy.douyu.com:6671/', 'C:\\fixture\\network.cjs', ['8.8.8.8'])
    expect(options!.workerData).toMatchObject({ addresses: ['8.8.8.8'], windowLimit: 8 * 1_048_576 })
    // Evaluate only our local static transport, against fake WebSocket/dispatcher objects.
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
    const dispatcher = { destroy: vi.fn(async () => {}) }
    const sockets: { listeners: Record<string, (event: { data: ArrayBuffer }) => void>; close: ReturnType<typeof vi.fn> }[] = []
    let now = 0
    runInNewContext(source, {
      require: (name: string) => name === 'node:worker_threads' ? { parentPort: port, workerData: options!.workerData } : { createPinnedDispatcher: vi.fn(() => dispatcher) },
      URL, ArrayBuffer, Date: { now: () => now },
      WebSocket: class { listeners: Record<string, (event: { data: ArrayBuffer }) => void> = {}; close = vi.fn(); binaryType = ''; constructor() { sockets.push(this) } addEventListener(type: string, listener: (event: { data: ArrayBuffer }) => void) { this.listeners[type] = listener } },
    })
    for (let index = 0; index < 20; index++) { now = index * 60_000; sockets[0]!.listeners.message!({ data: new ArrayBuffer(1_048_576) }) }
    expect(port.postMessage).toHaveBeenCalledTimes(20)
    sockets[0]!.listeners.message!({ data: new ArrayBuffer(1_048_577) })
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'error' }); expect(sockets[0]!.close).toHaveBeenCalledOnce()
    await socket.terminate(); expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects credentialed URLs, untrusted ports and malformed pinned addresses', () => {
    for (const url of ['wss://user@wsproxy.douyu.com:6671/', 'wss://wsproxy.douyu.com:9999/', 'wss://evil.invalid:6671/']) {
      expect(() => new NativeWatchSocket(url, 'C:\\fixture\\network.cjs', ['8.8.8.8'])).toThrow()
    }
    expect(() => new NativeWatchSocket('wss://wsproxy.douyu.com:6671/', 'C:\\fixture\\network.cjs', ['invalid'])).toThrow()
    expect(workerFixture.make).not.toHaveBeenCalled()
    expect(new DouyuWatchGatewayError('protocol-unsupported').message).not.toContain('kd')
  })
})
