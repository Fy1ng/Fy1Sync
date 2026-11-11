/** Account-owned viewing gateway. Receipts confirm transport, never official watch-time. */
import { isIP } from 'node:net'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { hostAllowed } from '../config'
import { dnsResolver, safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelled, cancelBody, MAX_TIMEOUT_MS, readPayload } from './actionHttp'
import {
  encodeMessageFrame, gatewayAddress, MAX_BUFFER_BYTES, MessageProtocolError, messageChallenge,
  messageCredentials, messageLogin, messageSigningKeys, signMessageGateway,
  type GatewayMessage, type MessageChallenge, type MessageCredentials, type MessageSigningKeys,
} from './messageProtocol'
import type { DouyuMessageSocket, MessageSocketEvent } from './messageSender'
import { DouyuWatchFrameDecoder, parseDouyuWatchKdTransform, readWatchHeartbeatChallenge, readWatchKd } from './watchProtocol'

const SITE = 'https://www.douyu.com/'
const SITE_HOST = 'www.douyu.com'
const SOCKET_HOST = 'wsproxy.douyu.com'
// Verified in current official common_6a22e8b ConnectServer on 2026-11-05. A changed or
// unsupported challenge ends the session; no fabricated fallback keeps it alive.
export const DOUYU_WATCH_HEARTBEAT_MS = 45_000
const MAX_OUTBOUND_BYTES = 65_536
const ALLOWED_MESSAGES = new Set(['loginreq', 'livreq', 'lsigreq', 'keeplive', 'logout'])

export interface DouyuWatchPlaybackStats { bytes: number; cdn: string }
export type DouyuWatchGatewayErrorCode = 'invalid-arguments' | 'login-required' | 'account-changed' | 'protocol-unsupported' | 'network-error' | 'timeout'
export class DouyuWatchGatewayError extends Error {
  constructor(readonly code: DouyuWatchGatewayErrorCode) {
    super({ 'invalid-arguments': '斗鱼观看参数无效.', 'login-required': '请重新登录斗鱼账号.',
      'account-changed': '斗鱼登录信息已变化.', 'protocol-unsupported': '斗鱼观看协议暂不支持, 已停止上报.',
      'network-error': '斗鱼观看连接失败.', timeout: '斗鱼观看连接未及时回应.' }[code])
    this.name = 'DouyuWatchGatewayError'
  }
}

export type DouyuWatchGatewayDependencies = DouyuActionDependencies & {
  networkRuntimePath?: string
  now?: () => number
  createSocket?: (url: string, addresses: readonly string[]) => DouyuMessageSocket
}

// Static, local transport code only. Credential interpretation and protocol decisions
// remain in the parent. Bound each message and a rolling traffic window, not all bytes
// since connection start, so a long viewing session can stay connected safely.
const WATCH_SOCKET_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let socket, dispatcher, ending = false, windowAt = Date.now(), bytes = 0;
function report(type, data = {}) { parentPort.postMessage({ type, ...data }); }
try {
  const { createPinnedDispatcher } = require(workerData.runtimePath);
  dispatcher = createPinnedDispatcher(new URL(workerData.url).hostname, workerData.addresses);
  socket = new WebSocket(workerData.url, { dispatcher });
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => { if (!ending) report('open'); });
  socket.addEventListener('error', () => { if (!ending) report('error'); });
  socket.addEventListener('close', event => { void dispatcher.destroy().catch(() => {}); report('close', { code: event.code }); });
  socket.addEventListener('message', event => {
    if (ending) return;
    const now = Date.now();
    if (now < windowAt || now - windowAt >= 60000) { windowAt = now; bytes = 0; }
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > workerData.limit || (bytes += event.data.byteLength) > workerData.windowLimit) {
      ending = true; report('error'); socket.close(1000); return;
    }
    parentPort.postMessage({ type: 'message', data: event.data }, [event.data]);
  });
  parentPort.on('message', command => {
    try {
      if (command.type === 'close') { ending = true; socket.close(1000); }
      else if (!ending && command.type === 'send' && command.data instanceof ArrayBuffer && command.data.byteLength <= workerData.outboundLimit && socket.readyState === 1) socket.send(command.data);
      else report('error');
    } catch { report('error'); }
  });
} catch { report('error'); }
`

export class NativeWatchSocket implements DouyuMessageSocket {
  readyState = 0
  binaryType = 'arraybuffer'
  private readonly worker: Worker
  private readonly listeners = new Map<string, Set<(event: MessageSocketEvent) => void>>()
  private ending: Promise<unknown> | null = null

  constructor(url: string, runtimePath: string, addresses: readonly string[]) {
    // Apply the same host/port contract again at the actual transport boundary.
    const target = new URL(url)
    if (target.protocol !== 'wss:' || target.hostname !== SOCKET_HOST || target.username || target.password
      || target.pathname !== '/' || target.search || target.hash || !/^667[1-5]$/.test(target.port)
      || !path.isAbsolute(runtimePath) || !addresses.length || addresses.length > 64 || addresses.some(value => !isIP(value))) throw new MessageProtocolError()
    this.worker = new Worker(WATCH_SOCKET_WORKER, { eval: true, name: 'douyu-watch', workerData: {
      url, runtimePath, addresses: [...addresses], limit: MAX_BUFFER_BYTES, windowLimit: MAX_BUFFER_BYTES * 8, outboundLimit: MAX_OUTBOUND_BYTES,
    } })
    this.worker.on('message', (event: MessageSocketEvent & { type: string }) => {
      if (this.ending) return
      if (event.type === 'open') this.readyState = 1
      if (event.type === 'close') this.readyState = 3
      for (const listener of this.listeners.get(event.type) ?? []) listener(event)
    })
    this.worker.on('error', () => { if (!this.ending) this.emit('error') })
    this.worker.on('exit', () => { if (!this.ending) { this.readyState = 3; this.emit('close') } })
  }
  private emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener({}) }
  addEventListener(type: string, listener: (event: MessageSocketEvent) => void): void {
    const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group)
  }
  removeEventListener(type: string, listener: (event: MessageSocketEvent) => void): void { this.listeners.get(type)?.delete(listener) }
  send(data: Uint8Array): void {
    if (this.ending || this.readyState !== 1 || data.byteLength > MAX_OUTBOUND_BYTES) throw new MessageProtocolError()
    const copy = Uint8Array.from(data); this.worker.postMessage({ type: 'send', data: copy.buffer }, [copy.buffer])
  }
  close(): void { if (!this.ending && this.readyState !== 3) { this.readyState = 2; this.worker.postMessage({ type: 'close' }) } }
  terminate(): Promise<unknown> {
    this.ending ??= this.worker.terminate().finally(() => { this.readyState = 3; this.listeners.clear(); this.worker.removeAllListeners() })
    return this.ending
  }
}

export class DouyuWatchGateway {
  constructor(private readonly deps: DouyuWatchGatewayDependencies) {}

  private clock(): number {
    const now = (this.deps.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < 0) throw new DouyuWatchGatewayError('invalid-arguments')
    return now
  }
  private async resolve(host: string, signal: AbortSignal): Promise<string[]> {
    const addresses = await abortable((this.deps.resolve ?? dnsResolver)(host), signal)
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(value => typeof value !== 'string' || !isIP(value))) throw new DouyuWatchGatewayError('network-error')
    return [...new Set(addresses)]
  }
  private async credentials(accountId: string, signal: AbortSignal): Promise<MessageCredentials> {
    const value = messageCredentials(await abortable(this.deps.cookieHeader(accountId, SITE), signal))
    if (!value) throw new DouyuWatchGatewayError('login-required')
    return value
  }
  private async json(url: string, method: 'GET' | 'POST', signal: AbortSignal): Promise<unknown> {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.hostname !== SITE_HOST || target.port || target.username || target.password || target.hash) throw new DouyuWatchGatewayError('protocol-unsupported')
    const { response } = await safeFetch(url, { ...this.deps.proxy, hosts: [SITE_HOST], maxRedirects: 0, allowNonStandardPorts: false }, {
      method, signal, headers: { Accept: 'application/json' }, resolve: host => this.resolve(host, signal), fetchImpl: this.deps.request ?? fetch,
    })
    if (signal.aborted) { cancelBody(response); throw cancelled() }
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) { cancelBody(response); throw new DouyuWatchGatewayError('network-error') }
    return readPayload(response, signal)
  }

  async run(accountId: string, room: string, signal: AbortSignal, stats: () => DouyuWatchPlaybackStats, onHeartbeat: (at: number) => void): Promise<void> {
    if (!validDouyuRoom(room) || typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)
      || typeof stats !== 'function' || typeof onHeartbeat !== 'function') throw new DouyuWatchGatewayError('invalid-arguments')
    if (signal.aborted) throw cancelled()
    if (!this.deps.proxy.enabled || ![SITE_HOST, SOCKET_HOST].every(host => hostAllowed(host, this.deps.proxy.hosts))) throw new DouyuWatchGatewayError('network-error')
    const timeout = new AbortController()
    const initialization = AbortSignal.any([signal, timeout.signal])
    const startupTimer = setTimeout(() => timeout.abort(), MAX_TIMEOUT_MS)
    let socket: DouyuMessageSocket | null = null
    try {
      const credentials = await this.credentials(accountId, initialization)
      const keys = messageSigningKeys(await abortable(this.json(`${SITE}wgapi/livenc/liveweb/websec/getEncryption?did=${encodeURIComponent(credentials.did)}`, 'GET', initialization), initialization))
      const endpoint = gatewayAddress(await abortable(this.json(`${SITE}lapi/live/gateway/web/${room}?isH5=1`, 'POST', initialization), initialization))
      const addresses = await this.resolve(SOCKET_HOST, initialization)
      if (initialization.aborted) throw cancelled()
      if (this.deps.createSocket) socket = this.deps.createSocket(endpoint, addresses)
      else {
        if (!this.deps.networkRuntimePath) throw new DouyuWatchGatewayError('network-error')
        socket = new NativeWatchSocket(endpoint, this.deps.networkRuntimePath, addresses)
      }
      clearTimeout(startupTimer)
      await this.exchange(socket, credentials, keys, accountId, room, signal, stats, onHeartbeat)
    } catch (error) {
      if (signal.aborted) throw cancelled()
      if (timeout.signal.aborted) throw new DouyuWatchGatewayError('timeout')
      if (error instanceof DouyuWatchGatewayError) throw error
      throw new DouyuWatchGatewayError(error instanceof MessageProtocolError ? 'protocol-unsupported' : 'network-error')
    } finally {
      clearTimeout(startupTimer)
      if (socket) {
        try { socket.close(1000, 'Viewing session ended') } catch { /* Termination releases a stalled socket. */ }
        try { await socket.terminate?.() } catch { /* Raw worker failures never reach the renderer. */ }
      }
    }
  }

  private exchange(socket: DouyuMessageSocket, credentials: MessageCredentials, keys: MessageSigningKeys, accountId: string,
    room: string, signal: AbortSignal, stats: () => DouyuWatchPlaybackStats, onHeartbeat: (at: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const decoder = new DouyuWatchFrameDecoder()
      let done = false, authenticated = false, challengeSigned = false, awaitingTick: string | null = null
      let receivedHeartbeat = false, deliveredHeartbeat = false, lastAckAt = 0, lastSentAt = 0
      let challenge: MessageChallenge | undefined
      let nextKd = ''
      let transformKd: ((kd: string) => string) | null = null
      let nextHeartbeat: ReturnType<typeof setTimeout> | null = null
      let deadline: ReturnType<typeof setTimeout> | null = null
      let chain = Promise.resolve()
      const finish = (error?: unknown) => {
        if (done) return
        done = true
        if (nextHeartbeat) clearTimeout(nextHeartbeat)
        if (deadline) clearTimeout(deadline)
        signal.removeEventListener('abort', abort)
        for (const [type, listener] of listeners) socket.removeEventListener(type, listener)
        decoder.clear()
        if (error) reject(error); else resolve()
      }
      const armDeadline = () => { if (deadline) clearTimeout(deadline); deadline = setTimeout(() => finish(new DouyuWatchGatewayError('timeout')), MAX_TIMEOUT_MS) }
      const write = (message: Record<string, string | number>) => {
        if (done || signal.aborted) throw cancelled()
        if (!ALLOWED_MESSAGES.has(String(message.type))) throw new DouyuWatchGatewayError('protocol-unsupported')
        const frame = encodeMessageFrame(message)
        if (frame.byteLength > MAX_OUTBOUND_BYTES) throw new DouyuWatchGatewayError('protocol-unsupported')
        socket.send(frame)
      }
      const verifyAccount = async () => {
        const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(MAX_TIMEOUT_MS)])
        let current: MessageCredentials
        try { current = await this.credentials(accountId, checkSignal) }
        catch (error) {
          if (checkSignal.aborted && !signal.aborted) throw new DouyuWatchGatewayError('timeout')
          throw error
        }
        if (done || signal.aborted) throw cancelled()
        if (Object.keys(credentials).some(key => current[key as keyof MessageCredentials] !== credentials[key as keyof MessageCredentials])) throw new DouyuWatchGatewayError('account-changed')
      }
      const heartbeat = async () => {
        await verifyAccount()
        const observation = stats()
        if (!observation || !Number.isSafeInteger(observation.bytes) || observation.bytes < 0 || observation.bytes > 0x3c00000
          || typeof observation.cdn !== 'string' || !/^[A-Za-z0-9_-]{0,64}$/.test(observation.cdn)) throw new DouyuWatchGatewayError('invalid-arguments')
        lastSentAt = this.clock()
        const tick = Math.floor(lastSentAt / 1000)
        const signature = signMessageGateway('heartbeat', keys, room, credentials.did, tick, challenge)
        const kd = nextKd
        challenge = undefined; nextKd = ''; awaitingTick = String(tick); receivedHeartbeat = false; deliveredHeartbeat = false
        armDeadline()
        write({ type: 'keeplive', vbw: observation.bytes, cdn: observation.cdn, tick, kd, ...signature })
      }
      const acknowledge = () => {
        if (!challengeSigned || !receivedHeartbeat || deliveredHeartbeat || done) return
        deliveredHeartbeat = true
        if (deadline) { clearTimeout(deadline); deadline = null }
        onHeartbeat(lastAckAt)
        nextHeartbeat = setTimeout(() => enqueue(heartbeat), Math.max(0, DOUYU_WATCH_HEARTBEAT_MS - (this.clock() - lastSentAt)))
      }
      const handle = async (message: GatewayMessage) => {
        if (done || signal.aborted) return
        if (['rid', 'roomid'].some(key => message[key] !== undefined && message[key] !== room)) return
        if (message.type === 'error') throw new DouyuWatchGatewayError('login-required')
        if (message.type === 'loginres') {
          if (authenticated || message.userid !== credentials.uid || message.username !== credentials.username
            || ['code', 'error'].some(key => message[key] !== undefined && message[key] !== '0') || message.is_illegal === '1') throw new DouyuWatchGatewayError('login-required')
          authenticated = true
          write({ type: 'livreq', alg_ver: '1.0', key_ver: keys.login.version })
          await heartbeat()
        } else if (message.type === 'livres') {
          if (!authenticated) throw new DouyuWatchGatewayError('protocol-unsupported')
          const ts = Math.floor(this.clock() / 1000)
          const signed = signMessageGateway('login', keys, room, credentials.did, ts, messageChallenge(message))
          write({ type: 'lsigreq', sig: signed.sig, ts })
          challengeSigned = true
          acknowledge()
        } else if (message.type === 'keeplive') {
          if (!authenticated || awaitingTick === null || message.tick !== awaitingTick || receivedHeartbeat) return
          if (['code', 'error'].some(key => message[key] !== undefined && message[key] !== '0')) throw new DouyuWatchGatewayError('protocol-unsupported')
          const receivedAt = this.clock()
          challenge = readWatchHeartbeatChallenge(message)
          const kd = readWatchKd(message.kd)
          if (kd && !transformKd) {
            const loadSignal = AbortSignal.any([signal, AbortSignal.timeout(MAX_TIMEOUT_MS)])
            let payload: unknown
            try { payload = await abortable(this.json(`${SITE}swf_api/homeH5Enc?rids=${room}`, 'GET', loadSignal), loadSignal) }
            catch (error) {
              if (loadSignal.aborted && !signal.aborted) throw new DouyuWatchGatewayError('timeout')
              throw error
            }
            if (done || signal.aborted) throw cancelled()
            transformKd = parseDouyuWatchKdTransform(payload, room)
          }
          nextKd = kd ? transformKd!(kd) : ''
          receivedHeartbeat = true; lastAckAt = receivedAt; awaitingTick = null
          acknowledge()
        }
      }
      const enqueue = (work: () => void | Promise<void>) => { chain = chain.then(() => { if (!done) return work() }).catch(error => finish(error)) }
      const abort = () => finish(cancelled())
      const listeners: [string, (event: MessageSocketEvent) => void][] = [
        ['open', () => enqueue(async () => { await verifyAccount(); write(messageLogin(room, credentials, Math.floor(this.clock() / 1000))) })],
        ['message', event => {
          try { const messages = decoder.feed(event.data, this.clock()); for (const message of messages) enqueue(() => handle(message)) }
          catch { finish(new DouyuWatchGatewayError('protocol-unsupported')) }
        }],
        ['error', () => finish(new DouyuWatchGatewayError('network-error'))],
        ['close', () => finish(new DouyuWatchGatewayError('network-error'))],
      ]
      for (const [type, listener] of listeners) socket.addEventListener(type, listener)
      signal.addEventListener('abort', abort, { once: true })
      armDeadline()
      if (signal.aborted) abort()
    })
  }
}
