import { AsyncLocalStorage } from 'node:async_hooks'
import type { Socket } from 'node:net'
import { Client, Dispatcher, ProxyAgent, Socks5ProxyAgent, buildConnector } from 'undici'
import type { NetworkRoute } from './networkPolicy'

const connectFailures = new WeakSet<Error>()
const CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
interface PendingConnection { sockets: Set<Socket>; cancelled?: Error }

/** Only trusted transport adapters may establish that a request was not sent. */
export function markProxyConnectFailure(error: Error): Error { connectFailures.add(error); return error }

export function isProxyConnectFailure(error: unknown): boolean {
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  let marked = false
  while (pending.length && seen.size < 32) {
    const value = pending.shift()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const item = value as { code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown; cause?: unknown; errors?: unknown; failure?: { code?: unknown; stage?: unknown } }
    const code = String(item.code ?? item.failure?.code ?? '')
    if (/CERT|TLS|SSL|AUTH|REJECT|SOCKS5_(?:REPLY|VERSION|ADDR|AUTH)|HTTP_[45]/i.test(code)
      || item.status !== undefined || item.statusCode !== undefined || item.failure?.stage === 'http'
      || item.name === 'AbortError' || item.name === 'TimeoutError') return false
    if (value instanceof Error && connectFailures.has(value)) marked = true
    pending.push(item.cause)
    if (Array.isArray(item.errors)) pending.push(...item.errors)
  }
  return marked
}

/** Own pending proxy sockets too: Undici's experimental SOCKS agent does not. */
class ManagedProxyDispatcher extends Dispatcher {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  constructor(private readonly inner: Dispatcher, private readonly sockets: Set<Socket>, private readonly timeoutMs: number,
    private readonly connections: number, private readonly pending: AsyncLocalStorage<PendingConnection>) { super() }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const owner: PendingConnection = { sockets: new Set() }
    let completed = false
    let cancelled = false
    let abortTransport: ((reason?: Error) => void) | undefined
    const clear = () => { clearTimeout(timer); this.timers.delete(timer) }
    const finish = () => { if (!completed) { completed = true; clear() } }
    const releasePending = (error: Error) => { for (const socket of owner.sockets) socket.destroy(error); owner.sockets.clear() }
    const cancel = (error: Error) => {
      if (completed) return
      if (abortTransport) { abortTransport(error); return }
      cancelled = true; owner.cancelled = error; finish(); releasePending(error)
      if (handler.onError) handler.onError(error)
      else if (handler.onResponseError) Reflect.apply(handler.onResponseError, handler, [undefined, error])
    }
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('代理请求建立超时.'), { code: 'UND_ERR_PROXY_HANDSHAKE_TIMEOUT' })
      cancel(error)
    // Let the connector report its marked TCP/DNS timeout before the broader
    // handshake deadline. A tunnel or source timeout must never trigger fallback.
    }, this.timeoutMs + 100)
    this.timers.add(timer)
    // Fetch normally receives its abort callback only after the tunnel connects.
    // Register cancellation now so an abandoned SOCKS handshake cannot outlive it.
    const earlyConnect = typeof handler.onConnect === 'function' && typeof handler.onRequestStart !== 'function'
    if (earlyConnect) handler.onConnect!((reason?: Error) => cancel(reason ?? Object.assign(new Error('代理请求已取消.'), { name: 'AbortError' })))
    if (cancelled) return true
    const wrapped = new Proxy(handler, { get: (target, name) => {
      const original: unknown = Reflect.get(target, name)
      if (typeof original !== 'function') return original
      return (...args: unknown[]) => {
        if (name === 'onConnect' && earlyConnect) {
          abortTransport = args[0] as (reason?: Error) => void
          // A connected socket now belongs to its pool; normal request abort
          // handles it. Pending handshakes remain owned by their dispatch only.
          owner.sockets.clear()
          if (cancelled) abortTransport(Object.assign(new Error('代理请求已取消.'), { name: 'AbortError' }))
          return
        }
        if (name === 'onRequestStart') owner.sockets.clear()
        if (cancelled) return
        if (name === 'onHeaders' || name === 'onResponseStart' || name === 'onUpgrade' || name === 'onRequestUpgrade') clear()
        if (name === 'onComplete' || name === 'onResponseEnd' || name === 'onUpgrade' || name === 'onRequestUpgrade') finish()
        if (name === 'onError' || name === 'onResponseError') {
          finish(); releasePending(new Error('代理连接已取消.'))
        }
        return Reflect.apply(original, target, args)
      }
    } })
    // The experimental SOCKS agent reads its pool limit from dispatch options.
    const settings = { ...options, connections: this.connections }
    try { return this.pending.run(owner, () => this.inner.dispatch(settings, wrapped)) }
    catch (error) { finish(); releasePending(new Error('代理请求失败.')); throw error }
  }
  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    const pending = this.inner.close().finally(() => this.release())
    if (callback) { void pending.then(callback, callback); return }
    return pending
  }
  override destroy(): Promise<void>
  override destroy(error: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(error: Error | null, callback: () => void): void
  override destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    this.release()
    const pending = this.inner.destroy(typeof errorOrCallback === 'function' ? null : errorOrCallback ?? null)
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    if (done) { void pending.then(done, done); return }
    return pending
  }
  private release(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const socket of this.sockets) socket.destroy(new Error('代理连接已关闭.'))
    this.sockets.clear()
  }
}

export function createProxyDispatcher(route: NetworkRoute, timeoutMs: number, connections = 1): Dispatcher {
  if ((route.kind !== 'http' && route.kind !== 'socks5') || !route.proxyUrl) throw new Error('系统代理类型不受支持.')
  const proxy = new URL(route.proxyUrl)
  if (!(route.kind === 'http' ? ['http:', 'https:'] : ['socks5:']).includes(proxy.protocol)
    || !proxy.hostname || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error('系统代理地址无效.')
  const sockets = new Set<Socket>()
  const pending = new AsyncLocalStorage<PendingConnection>()
  const connect = buildConnector({ timeout: timeoutMs, rejectUnauthorized: true, autoSelectFamily: true })
  const tracked: buildConnector.connector = (options, callback) => {
    const owner = pending.getStore()
    if (owner?.cancelled) { queueMicrotask(() => callback(owner.cancelled!, null)); return }
    const socket = connect(options, (error, connected) => {
      if (error) {
        if (CONNECT_CODES.has(String((error as NodeJS.ErrnoException).code))) markProxyConnectFailure(error)
        callback(error, null)
      } else callback(null, connected)
    }) as unknown as Socket
    sockets.add(socket)
    owner?.sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); owner?.sockets.delete(socket) })
  }
  const settings = { connections, headersTimeout: timeoutMs, bodyTimeout: 0, requestTls: { rejectUnauthorized: true, timeout: timeoutMs } }
  const inner = route.kind === 'socks5'
    ? new Socks5ProxyAgent(proxy, { ...settings, connect: tracked })
    : new ProxyAgent({ ...settings, uri: proxy.href, proxyTls: { rejectUnauthorized: true, timeout: timeoutMs },
      clientFactory: (origin, options) => new Client(origin, { ...options, connect: tracked, headersTimeout: timeoutMs }) })
  return new ManagedProxyDispatcher(inner, sockets, timeoutMs, connections, pending)
}
