import { WebSocket, type Dispatcher } from 'undici'
import { networkContext, routeCandidates, routeUsesRemoteDns, type NetworkContext } from '../networkPolicy'
import { checkUrl, createPinnedDispatcher, type Resolver } from '../safeFetch'
import { createProxyDispatcher, isProxyConnectFailure } from '../proxyDispatcher'
import type { DanmakuPlatform, WebSocketLike } from './types'

const ENDPOINTS = {
  douyu: { hostname: 'danmuproxy.douyu.com', port: '8506' },
  huya: { hostname: 'cdnws.api.huya.com', port: '' },
} as const

export interface NetworkSocketOptions {
  network?: NetworkContext
  resolve?: Resolver
  timeoutMs?: number
  /** Main-produced Douyin handshake metadata. Login cookies never reach this socket. */
  headers?: Record<string, string>
}

/** Defer transport creation until the platform policy and direct DNS guard have settled. */
export function createNetworkSocket(raw: string, platform: DanmakuPlatform, options: NetworkSocketOptions = {}): WebSocketLike {
  const url = new URL(raw)
  const expected = platform === 'douyin' ? { hostname: url.hostname, port: '' } : ENDPOINTS[platform]
  const douyinTarget = platform === 'douyin'
    && /^webcast[1-9][0-9]{0,2}-ws-web-(?:lf|hl|lq)\.douyin\.com$/.test(url.hostname)
    && url.pathname === '/webcast/im/push/v2/' && raw.length <= 32_768 && !/[\x00-\x20\x7f]/.test(raw)
  if (!expected || url.protocol !== 'wss:' || url.hostname !== expected.hostname || url.port !== expected.port
    || url.username || url.password || url.hash
    || (platform === 'douyin' ? !douyinTarget : url.pathname !== '/' || url.search)) throw new Error('弹幕连接地址不在允许范围内.')
  let headers: Record<string, string> | undefined
  if (options.headers) {
    if (platform !== 'douyin' || Object.keys(options.headers).length > 4) throw new Error('弹幕请求头不在允许范围内.')
    headers = {}
    for (const [key, value] of Object.entries(options.headers)) {
      const name = key.toLowerCase()
      if (!['cookie', 'user-agent', 'origin', 'referer'].includes(name) || typeof value !== 'string' || value.length > 8192
        || /[\x00-\x1f\x7f]/.test(value) || Object.hasOwn(headers, name)
        || (name === 'origin' && value !== 'https://live.douyin.com')
        || (name === 'referer' && value !== 'https://live.douyin.com/')
        || (name === 'cookie' && !/^ttwid=[^;\s]{1,4096}$/.test(value))) throw new Error('弹幕请求头不在允许范围内.')
      headers[name] = value
    }
  }
  const network = options.network ?? networkContext(platform)
  const listeners = new Map<string, Set<(event: any) => void>>()
  let transport: WebSocketLike | undefined
  let dispatcher: Dispatcher | undefined
  let stopped = false
  let opened = false
  let binaryType = 'arraybuffer'
  let settleAttempt: ((value: unknown) => void) | undefined
  const timeoutMs = options.timeoutMs ?? 15_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearDeadline = () => { clearTimeout(timer); timer = undefined }
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      try { listener(event) } catch { /* One observer cannot retain the network transport. */ }
    }
  }
  const release = () => {
    clearDeadline()
    const settle = settleAttempt
    settleAttempt = undefined
    settle?.(new Error('弹幕连接已释放.'))
    const owned = dispatcher
    dispatcher = undefined
    if (owned) void owned.destroy().catch(() => {})
  }
  const fail = () => {
    if (stopped) return
    stopped = true
    try { transport?.close() } catch { /* The connection may have failed before opening. */ }
    release()
    // Never expose a dispatcher error or a remote close reason that could contain credentials.
    emit('error', { message: '弹幕网络连接失败, 请检查出网设置.' })
    emit('close', { code: 1006, reason: '弹幕网络连接已断开.', wasClean: false })
  }
  const facade: WebSocketLike = {
    addEventListener(type, listener) {
      let entries = listeners.get(type)
      if (!entries) { entries = new Set(); listeners.set(type, entries) }
      entries.add(listener)
    },
    send(data) {
      if (stopped || !opened || !transport) throw new Error('弹幕连接尚未就绪.')
      transport.send(data)
    },
    close() {
      if (stopped) return
      stopped = true
      try { transport?.close() } catch { /* Transport teardown is idempotent. */ }
      release()
      queueMicrotask(() => emit('close', { code: 1000, reason: '', wasClean: true }))
    },
    get binaryType() { return binaryType },
    set binaryType(value) {
      binaryType = value === 'blob' ? 'blob' : 'arraybuffer'
      if (transport) transport.binaryType = binaryType
    },
  }
  timer = setTimeout(fail, timeoutMs)
  void (async () => {
    const routes = routeCandidates(await network.route(url.href))
    if (stopped) return
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]!
      if (route.kind === 'unsupported') {
        if (index + 1 < routes.length) continue
        throw new Error('系统代理类型不受支持.')
      }
      clearDeadline()
      timer = setTimeout(fail, timeoutMs)
      // Keep fixed endpoint validation while proxy DNS belongs to the selected route.
      const target = new URL(url)
      target.protocol = 'https:'
      const check = await checkUrl(target.href, { enabled: true, hosts: [expected.hostname], allowNonStandardPorts: platform === 'douyu',
        maxRedirects: 0, requestTimeoutMs: timeoutMs }, options.resolve, routeUsesRemoteDns(route))
      if (stopped) return
      if (!check.ok) throw new Error('弹幕连接地址校验失败.')
      dispatcher = route.kind === 'direct' ? createPinnedDispatcher(url.hostname, check.addresses)
        : createProxyDispatcher(route, timeoutMs)
      if (stopped) { release(); return }
      clearDeadline()
      // Proxy dispatchers need time to surface a proven connector timeout;
      // generic WebSocket/handshake timeouts still terminate this connection.
      timer = setTimeout(fail, timeoutMs + 200)
      const attempt = await new Promise<unknown>(resolve => {
        settleAttempt = resolve
        // Undici refuses HTTP redirects during the WebSocket handshake.
        const socket = new WebSocket(url.href, { dispatcher, ...(headers ? { headers } : {}) }) as unknown as WebSocketLike
        transport = socket
        socket.binaryType = binaryType
        socket.addEventListener('open', () => {
          if (stopped || transport !== socket) return
          opened = true; settleAttempt = undefined; clearDeadline(); emit('open', {}); resolve(null)
        })
        socket.addEventListener('message', (event: { data: unknown }) => { if (!stopped && opened && transport === socket) emit('message', { data: event.data }) })
        socket.addEventListener('error', (event: { error?: unknown }) => {
          if (stopped || transport !== socket) return
          if (opened) fail()
          else resolve(event.error ?? new Error('弹幕网络连接失败.'))
        })
        socket.addEventListener('close', (event: { code?: number; wasClean?: boolean }) => {
          if (stopped || transport !== socket) return
          if (!opened) { resolve(new Error('弹幕连接建立失败.')); return }
          stopped = true; release()
          emit('close', { code: event.code, wasClean: event.wasClean, reason: '弹幕连接已断开.' })
        })
      })
      if (stopped || opened) return
      const previous = transport
      transport = undefined
      try { previous?.close() } catch { /* The failed handshake may already be closed. */ }
      release()
      if (index + 1 >= routes.length || !isProxyConnectFailure(attempt)) throw attempt
    }
  })().catch(fail)
  return facade
}
