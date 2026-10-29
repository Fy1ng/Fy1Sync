import { ProxyAgent, WebSocket, type Dispatcher } from 'undici'
import { networkContext, type NetworkContext } from '../networkPolicy'
import { checkUrl, createPinnedDispatcher, type Resolver } from '../safeFetch'
import type { DanmakuPlatform, WebSocketLike } from './types'

const ENDPOINTS = {
  douyu: { hostname: 'danmuproxy.douyu.com', port: '8506' },
  huya: { hostname: 'cdnws.api.huya.com', port: '' },
} as const

export interface NetworkSocketOptions {
  network?: NetworkContext
  resolve?: Resolver
}

/** Defer transport creation until the platform policy and direct DNS guard have settled. */
export function createNetworkSocket(raw: string, platform: DanmakuPlatform, options: NetworkSocketOptions = {}): WebSocketLike {
  const expected = ENDPOINTS[platform]
  const url = new URL(raw)
  if (url.protocol !== 'wss:' || url.hostname !== expected.hostname || url.port !== expected.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('弹幕连接地址不在允许范围内.')
  const network = options.network ?? networkContext(platform)
  const listeners = new Map<string, Set<(event: any) => void>>()
  let transport: WebSocketLike | undefined
  let dispatcher: Dispatcher | undefined
  let stopped = false
  let binaryType = 'arraybuffer'
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) {
      try { listener(event) } catch { /* One observer cannot retain the network transport. */ }
    }
  }
  const release = () => {
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
      if (stopped || !transport) throw new Error('弹幕连接尚未就绪.')
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
  void (async () => {
    const route = await network.route(url.href)
    if (stopped) return
    // Reuse the existing direct DNS/private-address checks without broadening the WebSocket endpoint list.
    const target = new URL(url)
    target.protocol = 'https:'
    const check = await checkUrl(target.href, { enabled: true, hosts: [expected.hostname], allowNonStandardPorts: platform === 'douyu',
      allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: 15_000 }, options.resolve, route.kind === 'http')
    if (stopped) return
    if (!check.ok) throw new Error('弹幕连接地址校验失败.')
    dispatcher = route.kind === 'http'
      ? new ProxyAgent({ uri: route.proxyUrl!, requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
      : createPinnedDispatcher(url.hostname, check.addresses)
    if (stopped) { release(); return }
    // Undici's WebSocket handshake rejects HTTP redirects rather than following an unchecked target.
    const socket = new WebSocket(url.href, { dispatcher }) as unknown as WebSocketLike
    transport = socket
    socket.binaryType = binaryType
    socket.addEventListener('open', () => { if (!stopped) emit('open', {}) })
    socket.addEventListener('message', (event: { data: unknown }) => { if (!stopped) emit('message', { data: event.data }) })
    socket.addEventListener('error', fail)
    socket.addEventListener('close', (event: { code?: number; wasClean?: boolean }) => {
      if (stopped) return
      stopped = true
      release()
      emit('close', { code: event.code, wasClean: event.wasClean, reason: '弹幕连接已断开.' })
    })
  })().catch(fail)
  return facade
}
