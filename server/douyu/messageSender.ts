/** One explicit message, one account-owned gateway, and an attributable receipt. */
import { isIP } from 'node:net'
import { Worker } from 'node:worker_threads'
import { hostAllowed } from '../config'
import { dnsResolver, isPrivateAddress, safeFetch } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import type { DouyuActionDependencies } from './actions'
import { abortable, cancelBody, cancelled, MAX_TIMEOUT_MS, readPayload } from './actionHttp'
import type { DouyuMessageInput, DouyuMessageOutcome, DouyuTerminalOutcome as DouyuTaskOutcome } from './types'
import {
  encodeMessageFrame, gatewayAddress, MAX_BUFFER_BYTES, MAX_COOLDOWN_MS, MAX_TOTAL_BYTES,
  MessageFrameDecoder, MessageProtocolError, messageChallenge, messageColorPalette, messageCredentials,
  messageLogin, messageSigningKeys, normalizeMessageText, receiptMatch,
  signMessageGateway, unsigned, type GatewayMessage, type MessageCredentials,
  type MessageSigningKeys,
} from './messageProtocol'

const SITE = 'https://www.douyu.com/'
const SITE_HOST = 'www.douyu.com'
const SOCKET_HOST = 'wsproxy.douyu.com'
const MAX_OUTBOUND_BYTES = 65_536
const MAX_ROOM_STATES = 1_024

export type MessageSocketEvent = { data?: unknown; code?: number }
type MessageSocketListener = (event: MessageSocketEvent) => void
export interface DouyuMessageSocket {
  readonly readyState?: number
  binaryType?: string
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: MessageSocketListener): void
  removeEventListener(type: string, listener: MessageSocketListener): void
  /** The default transport forcefully releases its worker and underlying socket. */
  terminate?(): void | Promise<unknown>
}
export type DouyuMessageSenderDependencies = DouyuActionDependencies & {
  createSocket?: (url: string) => DouyuMessageSocket
  now?: () => number
}

// Local, static application code only. Native WebSocket has no public terminate()
// API; owning it in a short-lived Node worker also bounds a stalled close handshake.
// Cookie access, protocol decisions and signing remain outside this transport.
const SOCKET_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let socket;
let incomingBytes = 0;
let rejected = false;
function report(type, data) { parentPort.postMessage({ type, ...data }); }
try {
  socket = new WebSocket(workerData.url);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => report('open'));
  socket.addEventListener('error', () => report('error'));
  socket.addEventListener('close', event => report('close', { code: event.code }));
  socket.addEventListener('message', event => {
    if (rejected) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > workerData.limit || (incomingBytes += event.data.byteLength) > workerData.totalLimit) {
      rejected = true;
      report('error'); socket.close(1000); return;
    }
    parentPort.postMessage({ type: 'message', data: event.data }, [event.data]);
  });
  parentPort.on('message', command => {
    try {
      if (command.type === 'close') socket.close(1000);
      else if (command.type === 'send' && command.data instanceof ArrayBuffer && command.data.byteLength <= workerData.limit && socket.readyState === 1) socket.send(command.data);
      else report('error');
    } catch { report('error'); }
  });
} catch { report('error'); }
`

/** Raw transport; DouyuMessageSender validates the official URL before constructing it. */
export class NativeMessageSocket implements DouyuMessageSocket {
  readyState = 0
  private readonly worker: Worker
  private readonly listeners = new Map<string, Set<MessageSocketListener>>()
  private ending: Promise<unknown> | null = null

  constructor(url: string) {
    this.worker = new Worker(SOCKET_WORKER, { eval: true, name: 'douyu-message', workerData: { url, limit: MAX_BUFFER_BYTES, totalLimit: MAX_TOTAL_BYTES } })
    this.worker.on('message', (event: MessageSocketEvent & { type: string }) => {
      if (this.ending) return
      if (event.type === 'open') this.readyState = 1
      if (event.type === 'close') this.readyState = 3
      this.emit(event.type, event)
    })
    this.worker.on('error', () => { if (!this.ending) this.emit('error', {}) })
    this.worker.on('exit', () => { if (!this.ending) { this.readyState = 3; this.emit('close', { code: 1006 }) } })
  }

  addEventListener(type: string, listener: MessageSocketListener): void {
    const group = this.listeners.get(type) ?? new Set<MessageSocketListener>()
    group.add(listener)
    this.listeners.set(type, group)
  }
  removeEventListener(type: string, listener: MessageSocketListener): void { this.listeners.get(type)?.delete(listener) }
  private emit(type: string, event: MessageSocketEvent): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
  send(data: Uint8Array): void {
    if (this.ending || this.readyState !== 1) throw new MessageProtocolError()
    const copy = Uint8Array.from(data)
    this.worker.postMessage({ type: 'send', data: copy.buffer }, [copy.buffer])
  }
  close(): void {
    if (!this.ending && this.readyState !== 3) {
      this.readyState = 2
      this.worker.postMessage({ type: 'close' })
    }
  }
  terminate(): Promise<unknown> {
    if (!this.ending) {
      this.listeners.clear()
      this.ending = this.worker.terminate().finally(() => { this.readyState = 3; this.worker.removeAllListeners() })
    }
    return this.ending
  }
}

type RoomState = { lastSentAt: number | null; cooldownMs: number | null; nextAllowedAt: number | null }
type Operation = { dispatched: boolean; closed: boolean; socket: DouyuMessageSocket | null; cleanup: (() => void) | null }
type MessageStepOutcome = DouyuTaskOutcome & { deferredUntil?: number }
const failed = (message: string): DouyuTaskOutcome => ({ status: 'failed', message })
const waiting = (message: string): DouyuTaskOutcome => ({ status: 'waiting-user', message })
const needLogin = () => waiting('斗鱼登录信息缺失, 已变化或无法核对. 请重新登录该账号后再发送.')
const cooling = () => waiting('斗鱼发言仍在冷却中. 请等待提示时间后再发送.')
const deferred = (until: number): MessageStepOutcome => ({ ...cooling(), deferredUntil: until })
const uncertain = () => waiting('斗鱼发送结果尚无法确认. 请在官方房间核对, 本次不会自动重发.')

const ERROR_MESSAGES: Record<number, string> = {
  2: '斗鱼提示该账号已被禁言.',
  5: '斗鱼提示该账号已被全站禁言.',
  6: '斗鱼房间当前仅允许满足粉丝资格的账号发言.',
  206: '斗鱼拒绝了本次发言操作.',
  208: '斗鱼未找到本次发言的目标.',
  289: '斗鱼限制了重复发言. 本次不会自动重发.',
  290: '斗鱼限制了发言频率. 请等待冷却结束.',
  308: '斗鱼拒绝了本次弹幕样式或特权请求.',
  391: '斗鱼要求官方账号验证. 请手动完成验证后核对本次发言.',
}

export class DouyuMessageSender {
  private readonly now: () => number
  private readonly createSocket: (url: string) => DouyuMessageSocket
  private readonly active = new Map<string, AbortController>()
  private readonly rooms = new Map<string, RoomState>()
  private lastCst = 0
  private disposed = false

  constructor(private readonly deps: DouyuMessageSenderDependencies) {
    this.now = deps.now ?? Date.now
    this.createSocket = deps.createSocket ?? (url => new NativeMessageSocket(url))
  }

  dispose(): void {
    this.disposed = true
    for (const operation of this.active.values()) operation.abort()
  }

  async send(input: DouyuMessageInput, signal: AbortSignal): Promise<DouyuMessageOutcome> {
    const text = normalizeMessageText(input?.text)
    const accountId = input?.accountId
    const room = input?.room
    const color = input?.color
    if (!text || typeof accountId !== 'string' || !accountId || accountId.length > 128 || /[\s\x00-\x1f\x7f]/.test(accountId) || typeof room !== 'string' || !validDouyuRoom(room) || !Number.isInteger(color) || color < 0 || color > 6) {
      return { ...failed('弹幕内容, 账号, 房间或颜色无效. 未发送弹幕.'), nextAllowedAt: null }
    }
    const target: DouyuMessageInput = { accountId, room, text, color }
    const stateKey = JSON.stringify([accountId, room])
    let state = this.rooms.get(stateKey)
    const current = this.clock()
    if (this.disposed || signal.aborted) return { ...failed('发送已取消. 未发送弹幕.'), nextAllowedAt: state?.nextAllowedAt ?? null }
    if (this.active.has(accountId)) return { ...waiting('该账号已有一条发送正在等待结果.'), nextAllowedAt: state?.nextAllowedAt ?? null }
    if (!this.deps.proxy.enabled || ![SITE_HOST, SOCKET_HOST].every(host => hostAllowed(host, this.deps.proxy.hosts))) return { ...failed('斗鱼发送目标未获网络策略允许. 未发送弹幕.'), nextAllowedAt: state?.nextAllowedAt ?? null }
    if (state?.nextAllowedAt !== null && state?.nextAllowedAt !== undefined && state.nextAllowedAt > current) return { ...deferred(state.nextAllowedAt), nextAllowedAt: state.nextAllowedAt }
    if (!state) {
      for (const [key, old] of this.rooms) if ((old.nextAllowedAt ?? 0) <= current && (old.lastSentAt === null || old.lastSentAt < current - MAX_COOLDOWN_MS)) this.rooms.delete(key)
      if (this.rooms.size >= MAX_ROOM_STATES) return { ...failed('暂时无法保存更多房间的发言冷却状态. 未发送弹幕.'), nextAllowedAt: null }
      state = { lastSentAt: null, cooldownMs: null, nextAllowedAt: null }
      this.rooms.set(stateKey, state)
    }
    const owner = new AbortController()
    const timeout = new AbortController()
    const timeoutMs = Number.isFinite(this.deps.proxy.requestTimeoutMs) ? Math.max(1, Math.min(this.deps.proxy.requestTimeoutMs, MAX_TIMEOUT_MS)) : MAX_TIMEOUT_MS
    const deadline = current + timeoutMs
    const timer = setTimeout(() => timeout.abort(), timeoutMs)
    const combined = AbortSignal.any([signal, owner.signal, timeout.signal])
    const context: Operation = { dispatched: false, closed: false, socket: null, cleanup: null }
    this.active.set(accountId, owner)
    let outcome: MessageStepOutcome
    try {
      outcome = await abortable(this.perform(target, state, context, combined, deadline), combined)
    } catch {
      outcome = context.dispatched ? uncertain() : failed(combined.aborted
        ? timeout.signal.aborted ? '斗鱼发送准备超时. 未发送弹幕.' : '发送已取消. 未发送弹幕.'
        : '无法安全完成斗鱼登录或发送准备. 未发送弹幕.')
    } finally {
      context.closed = true
      context.cleanup?.()
      clearTimeout(timer)
      if (context.socket) {
        try { context.socket.close(1000, 'Message operation finished') } catch { /* Fixed outcome only. */ }
        try { await context.socket.terminate?.() } catch { /* Never expose transport details. */ }
      }
      if (this.active.get(accountId) === owner) this.active.delete(accountId)
    }
    const { deferredUntil, ...result } = outcome
    // Never let a submitted, cancelled or stale result become an automatic retry.
    const canDefer = !context.dispatched && !combined.aborted && result.status === 'waiting-user' && deferredUntil !== undefined && Number.isSafeInteger(deferredUntil) && deferredUntil > this.clock()
    return { ...result, nextAllowedAt: state.nextAllowedAt, ...(canDefer ? { deferredUntil } : {}) }
  }

  private clock(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - MAX_COOLDOWN_MS) throw new MessageProtocolError()
    return value
  }

  private assertActive(signal: AbortSignal, context?: Operation): void { if (signal.aborted || context?.closed) throw cancelled() }

  private async resolve(hostname: string): Promise<string[]> {
    const addresses = await (this.deps.resolve ?? dnsResolver)(hostname)
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(address => typeof address !== 'string' || !isIP(address) || isPrivateAddress(address))) throw new MessageProtocolError()
    return addresses
  }

  private async getJson(url: string, method: 'GET' | 'POST', signal: AbortSignal): Promise<unknown> {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.hostname !== SITE_HOST || target.port || target.username || target.password || target.hash) throw new MessageProtocolError()
    this.assertActive(signal)
    const { response } = await safeFetch(url, {
      ...this.deps.proxy, hosts: [SITE_HOST], maxRedirects: 0,
      allowNonStandardPorts: false, allowNonLoopbackTargets: false,
    }, {
      method, signal, headers: { Accept: 'application/json' },
      resolve: host => this.resolve(host),
      fetchImpl: async (requestUrl, init) => {
        this.assertActive(signal)
        const response = await (this.deps.request ?? fetch)(requestUrl, init)
        if (signal.aborted) { cancelBody(response); throw cancelled() }
        return response
      },
    })
    if (signal.aborted || response.status !== 200 || response.redirected || (response.url && response.url !== url)) {
      cancelBody(response)
      this.assertActive(signal)
      throw new MessageProtocolError()
    }
    const body = await readPayload(response, signal)
    this.assertActive(signal)
    return body
  }

  private async credentials(accountId: string, signal: AbortSignal): Promise<MessageCredentials | null> {
    this.assertActive(signal)
    const header = await abortable(this.deps.cookieHeader(accountId, SITE), signal)
    this.assertActive(signal)
    return messageCredentials(header)
  }

  private async perform(target: DouyuMessageInput, state: RoomState, context: Operation, signal: AbortSignal, deadline: number): Promise<MessageStepOutcome> {
    let credentials: MessageCredentials | null
    try { credentials = await this.credentials(target.accountId, signal) } catch { this.assertActive(signal); return needLogin() }
    if (!credentials) return needLogin()
    const keys = messageSigningKeys(await this.getJson(`${SITE}wgapi/livenc/liveweb/websec/getEncryption?did=${encodeURIComponent(credentials.did)}`, 'GET', signal))
    const endpoint = gatewayAddress(await this.getJson(`${SITE}lapi/live/gateway/web/${target.room}?isH5=1`, 'POST', signal))
    // WebSocket permits exactly the published host/ports, without relaxing HTTP policy.
    await abortable(this.resolve(SOCKET_HOST), signal)
    this.assertActive(signal, context)
    const socket = this.createSocket(endpoint)
    context.socket = socket
    socket.binaryType = 'arraybuffer'
    return this.exchange(target, credentials, keys, state, context, socket, signal, deadline)
  }

  private exchange(target: DouyuMessageInput, credentials: MessageCredentials, keys: MessageSigningKeys, state: RoomState, context: Operation, socket: DouyuMessageSocket, signal: AbortSignal, deadline: number): Promise<MessageStepOutcome> {
    return new Promise((resolve, reject) => {
      const decoder = new MessageFrameDecoder()
      let done = false
      let loginSent = false
      let authenticated = false
      let challengeSigned = false
      let heartbeatReady = false
      let heartbeatTick: string | null = null
      let cst: string | null = null
      let rules: { maximum: number; cooldown: number } | null = null
      let colorPalette: ReadonlySet<number> | null = null
      let authorizing = false
      let messageVersion = 0
      let outboundBytes = 0
      let wakeup: ReturnType<typeof setTimeout> | null = null
      let processing = Promise.resolve()

      const finish = (outcome: MessageStepOutcome) => { if (!done) { done = true; resolve(outcome) } }
      const stop = () => { if (!done) { done = true; reject(cancelled()) } }
      const fail = () => { if (!done) { done = true; reject(new MessageProtocolError()) } }
      const check = () => { this.assertActive(signal, context); if (done) throw cancelled() }
      const write = (fields: Record<string, string | number>) => {
        check()
        if (socket.readyState !== undefined && socket.readyState !== 1) throw new MessageProtocolError()
        const frame = encodeMessageFrame(fields)
        outboundBytes += frame.byteLength
        if (outboundBytes > MAX_OUTBOUND_BYTES) throw new MessageProtocolError()
        socket.send(frame)
      }
      const confirmAccount = async () => {
        let current: MessageCredentials | null
        try { current = await this.credentials(target.accountId, signal) } catch { this.assertActive(signal, context); return false }
        check()
        return current !== null && Object.keys(credentials).every(name => current[name as keyof MessageCredentials] === credentials[name as keyof MessageCredentials])
      }
      const dispatch = async (): Promise<void> => {
        if (done || context.closed || context.dispatched || authorizing || !authenticated || !challengeSigned || !heartbeatReady || !rules) return
        check()
        if (target.text.length > rules.maximum) { finish(failed('弹幕超过斗鱼当前允许的长度. 未发送弹幕.')); return }
        if (target.color !== 0) {
          if (!colorPalette) return
          if (!colorPalette.has(target.color)) { finish(waiting('尚未取得斗鱼对该账号在当前房间使用所选颜色的确认. 未发送弹幕.')); return }
        }
        const now = this.clock()
        const due = state.nextAllowedAt ?? now
        if (due > now) {
          if (due >= deadline) { finish(deferred(due)); return }
          if (wakeup) clearTimeout(wakeup)
          wakeup = setTimeout(() => { wakeup = null; void dispatch().catch(fail) }, due - now)
          return
        }
        authorizing = true
        try {
          const confirmingVersion = messageVersion
          if (!await confirmAccount()) { finish(needLogin()); return }
          check()
          // Drain messages that arrived while credentials were being rechecked.
          // A newer initcl or terminal error must take effect before this write.
          if (messageVersion !== confirmingVersion) return
          if (target.text.length > rules.maximum) { finish(failed('弹幕超过斗鱼当前允许的长度. 未发送弹幕.')); return }
          const sentAt = this.clock()
          if ((state.nextAllowedAt ?? sentAt) > sentAt) { authorizing = false; await dispatch(); return }
          this.lastCst = Math.max(sentAt, this.lastCst + 1)
          cst = String(this.lastCst)
          // pe is the privileged-emoticon category, not the color switch. An
          // ordinary color explicitly unlocked by fdm uses the fans-color flag.
          const message = { type: 'chatmessage', content: target.text, sender: credentials.uid, dy: credentials.did, col: target.color, pe: 0, ifs: target.color === 0 ? 0 : 1, nc: 0, dat: 0, rev: 0, tts: 0, admzq: 0, cst }
          // A throw, abort or disconnect after this boundary cannot prove non-delivery.
          context.dispatched = true
          state.lastSentAt = sentAt
          state.cooldownMs = rules.cooldown
          state.nextAllowedAt = Math.max(state.nextAllowedAt ?? 0, sentAt + rules.cooldown)
          write(message)
        } finally { authorizing = false }
      }
      const handle = async (message: GatewayMessage) => {
        if (done || context.closed) return
        check()
        if (message.type === 'error') {
          const code = unsigned(message.code, 1_000_000)
          const detail = code === 59 ? '斗鱼提示该账号在其它位置登录, 连接已结束.' : code === 267 ? '斗鱼要求停止当前连接.' : '斗鱼拒绝或结束了当前登录连接.'
          finish(waiting(`${detail} ${context.dispatched ? '本次发送结果尚无法确认, 请在官方房间核对.' : '未发送弹幕, 请在官方房间核对该账号.'}`))
          return
        }
        if (message.type === 'loginres') {
          if (!loginSent || authenticated) throw new MessageProtocolError()
          if (message.userid !== credentials.uid || message.username !== credentials.username) { finish(needLogin()); return }
          if ((message.npv !== undefined && message.npv !== '0') || message.is_illegal === '1') { finish(waiting('该账号尚未满足斗鱼官方发言条件. 未发送弹幕, 请在官方房间核对.')); return }
          authenticated = true
          write({ type: 'livreq', alg_ver: '1.0', key_ver: keys.login.version })
          const tick = Math.floor(this.clock() / 1_000)
          heartbeatTick = String(tick)
          // The entire operation is capped below the official 45s heartbeat interval.
          write({ type: 'keeplive', vbw: 0, cdn: '', tick, kd: '', ...signMessageGateway('heartbeat', keys, target.room, credentials.did, tick) })
        } else if (message.type === 'livres') {
          if (!authenticated || challengeSigned) throw new MessageProtocolError()
          const ts = Math.floor(this.clock() / 1_000)
          const signature = signMessageGateway('login', keys, target.room, credentials.did, ts, messageChallenge(message))
          write({ type: 'lsigreq', sig: signature.sig, ts })
          challengeSigned = true
        } else if (message.type === 'keeplive') {
          if (!authenticated || message.tick !== heartbeatTick) return
          if (message.kd) throw new MessageProtocolError()
          if (message.nonce !== undefined) messageChallenge(message)
          heartbeatReady = true
        } else if (message.type === 'initcl') {
          if (!authenticated || message.uid !== credentials.uid) return
          const maximum = unsigned(message.maxl, 10_000)
          const cooldown = unsigned(message.cd, MAX_COOLDOWN_MS)
          const firstDelay = message.fcd === undefined ? 0 : unsigned(message.fcd, MAX_COOLDOWN_MS)
          if (maximum === null || maximum < 1 || cooldown === null || firstDelay === null) throw new MessageProtocolError()
          rules = { maximum, cooldown }
          state.cooldownMs = cooldown
          if (state.lastSentAt !== null) state.nextAllowedAt = Math.max(state.nextAllowedAt ?? 0, state.lastSentAt + cooldown)
          if (firstDelay > 0) state.nextAllowedAt = Math.max(state.nextAllowedAt ?? 0, this.clock() + firstDelay)
        } else if (message.type === 'fdm' && target.color !== 0) {
          if (!authenticated || ['uid', 'userid', 'sender'].some(name => message[name] !== undefined && message[name] !== credentials.uid) || ['rid', 'roomid'].some(name => message[name] !== undefined && message[name] !== target.room)) return
          if (Object.hasOwn(message, 'list')) colorPalette = messageColorPalette(message.list)
        } else if (message.type === 'chatres' && context.dispatched && cst !== null) {
          const match = receiptMatch(message, { uid: credentials.uid, room: target.room, text: target.text, cst })
          if (match === 'mismatch') return
          const code = unsigned(message.res, 1_000_000)
          if (code === null) throw new MessageProtocolError()
          if ((code === 288 || code === 356) && match !== 'match') return
          if (message.cd !== undefined) {
            const cooldown = unsigned(message.cd, MAX_COOLDOWN_MS / 1_000)
            if (cooldown === null) throw new MessageProtocolError()
            state.cooldownMs = cooldown * 1_000
            state.nextAllowedAt = Math.max(state.nextAllowedAt ?? 0, this.clock() + state.cooldownMs)
          }
          if (message.len !== undefined && (unsigned(message.len, 10_000) ?? 0) < 1) throw new MessageProtocolError()
          if ((code === 288 || code === 356) && ((target.color !== 0 && message.col === undefined) || (message.col !== undefined && unsigned(message.col, 6) !== target.color))) {
            finish(waiting('斗鱼回执未确认所选弹幕颜色. 弹幕可能已发送, 请在官方房间核对, 本次不会自动重发.'))
          } else if (code === 288 || code === 356) finish({ status: 'succeeded', message: '已收到斗鱼发送回执.' })
          else if (Object.hasOwn(ERROR_MESSAGES, code)) {
            const detail = ERROR_MESSAGES[code]!
            finish(match === 'unassociated'
              ? waiting(`${detail} 本次发送结果尚无法确认, 请在官方房间核对.`)
              : code === 391 || code === 6 ? waiting(detail) : failed(detail))
          } else finish(uncertain())
          return
        }
      }
      const onOpen = () => {
        processing = processing.then(async () => {
          if (done || context.closed) return
          if (!await confirmAccount()) { finish(needLogin()); return }
          check()
          loginSent = true
          write(messageLogin(target.room, credentials, Math.floor(this.clock() / 1_000)))
        }).catch(fail)
      }
      const onMessage: MessageSocketListener = event => {
        if (done || context.closed) return
        try {
          const messages = decoder.feed(event.data)
          if (messages.length) messageVersion++
          processing = processing.then(async () => { for (const message of messages) await handle(message); await dispatch() }).catch(fail)
        } catch { fail() }
      }
      const onClose = () => { if (!done) fail() }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('error', onClose)
      socket.addEventListener('close', onClose)
      signal.addEventListener('abort', stop, { once: true })
      context.cleanup = () => {
        done = true
        if (wakeup) clearTimeout(wakeup)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('error', onClose)
        socket.removeEventListener('close', onClose)
        signal.removeEventListener('abort', stop)
        decoder.clear()
      }
      if (signal.aborted) stop()
    })
  }
}
