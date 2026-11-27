import { AsyncLocalStorage } from 'node:async_hooks'
import { isIP, isIPv4, isIPv6, type Socket } from 'node:net'
import { Agent, Dispatcher, Pool, ProxyAgent, buildConnector } from 'undici'
import type { NetworkRoute } from './networkPolicy'

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
export const DEFAULT_PROXY_KEEP_ALIVE_TIMEOUT_MS = 60_000
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300

const connectFailures = new WeakSet<Error>()
const CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])
interface PendingConnection { sockets: Set<Socket>; cancelled?: Error }

function safeDestroySocket(socket: Socket, error?: Error): void {
  if (socket.destroyed) return
  if (error) {
    if (socket.listenerCount('error') === 0) socket.on('error', () => {})
    socket.destroy(error)
  } else {
    socket.destroy()
  }
}

function socksError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

function parseIPv6(address: string): Buffer {
  const buffer = Buffer.alloc(16)
  let normalized = address
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    const ipv4 = address.slice(lastColon + 1)
    if (isIPv4(ipv4)) {
      const octets = ipv4.split('.').map(Number)
      const high = ((octets[0]! << 8) | octets[1]!).toString(16)
      const low = ((octets[2]! << 8) | octets[3]!).toString(16)
      normalized = `${address.slice(0, lastColon)}:${high}:${low}`
    }
  }
  const doubleColon = normalized.indexOf('::')
  if (doubleColon !== -1) {
    const before = normalized.slice(0, doubleColon)
    const after = normalized.slice(doubleColon + 2)
    const beforeParts = before ? before.split(':') : []
    const afterParts = after ? after.split(':') : []
    let offset = 0
    for (const part of beforeParts) { buffer.writeUInt16BE(parseInt(part, 16), offset); offset += 2 }
    offset = 16 - afterParts.length * 2
    for (const part of afterParts) { buffer.writeUInt16BE(parseInt(part, 16), offset); offset += 2 }
  } else {
    const parts = normalized.split(':')
    for (let index = 0; index < parts.length; index++) buffer.writeUInt16BE(parseInt(parts[index]!, 16), index * 2)
  }
  return buffer
}

function buildSocks5ConnectRequest(targetHost: string, targetPort: number): Buffer {
  const bare = targetHost.replace(/^\[|\]$/g, '')
  let type: number
  let address: Buffer
  if (isIPv4(bare)) {
    type = 0x01
    address = Buffer.from(bare.split('.').map(Number))
  } else if (isIPv6(bare)) {
    type = 0x04
    address = parseIPv6(bare)
  } else {
    const domain = Buffer.from(bare, 'utf8')
    if (!domain.length || domain.length > 255) throw socksError('Invalid SOCKS5 target host', 'UND_ERR_SOCKS5_ADDR_TYPE')
    type = 0x03
    address = Buffer.concat([Buffer.from([domain.length]), domain])
  }
  const packet = Buffer.alloc(4 + address.length + 2)
  packet[0] = 0x05
  packet[1] = 0x01
  packet[2] = 0x00
  packet[3] = type
  address.copy(packet, 4)
  packet.writeUInt16BE(targetPort, 4 + address.length)
  return packet
}

async function establishSocks5Tunnel(
  proxy: URL,
  connector: buildConnector.connector,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<Socket> {
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '')
  const proxyPort = Number(proxy.port) || 1080
  // Invoke connector synchronously before awaiting so AsyncLocalStorage tracks this pending socket.
  const socket = await new Promise<Socket>((resolve, reject) => {
    connector({ hostname: proxyHost, host: proxyHost, port: String(proxyPort), protocol: 'http:' }, (error, connected) => {
      if (error || !connected) reject(error ?? new Error('代理连接失败'))
      else resolve(connected)
    })
  })
  if (socket.destroyed) throw Object.assign(new Error('代理请求已取消'), { name: 'AbortError' })

  const username = proxy.username ? decodeURIComponent(proxy.username) : ''
  const password = proxy.password ? decodeURIComponent(proxy.password) : ''
  const hasAuth = Boolean(username || password)
  const userBytes = hasAuth ? Buffer.from(username, 'utf8') : Buffer.alloc(0)
  const passBytes = hasAuth ? Buffer.from(password, 'utf8') : Buffer.alloc(0)
  if (userBytes.length > 255 || passBytes.length > 255) {
    safeDestroySocket(socket)
    throw socksError('SOCKS5 credentials too long', 'UND_ERR_SOCKS5_AUTH_FAILED')
  }
  const connectRequest = buildSocks5ConnectRequest(targetHost, targetPort)

  return await new Promise<Socket>((resolve, reject) => {
    let state: 'greeting' | 'auth' | 'connect' = 'greeting'
    let buffered: Buffer = Buffer.alloc(0)
    let settled = false
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      safeDestroySocket(socket, error)
      reject(error)
    }
    const succeed = (remaining: Buffer) => {
      if (settled) return
      settled = true
      cleanup()
      if (remaining.length > 0) socket.unshift(remaining)
      resolve(socket)
    }
    const onError = (error: Error) => fail(error)
    const onClose = () => fail(Object.assign(new Error('SOCKS5 代理连接已关闭'), { code: 'ECONNRESET' }))
    const onData = (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk
      while (!settled) {
        if (state === 'greeting') {
          if (buffered.length < 2) return
          const version = buffered[0]!
          const method = buffered[1]!
          buffered = buffered.subarray(2)
          if (version !== 0x05) { fail(socksError(`Invalid SOCKS version: ${version}`, 'UND_ERR_SOCKS5_VERSION')); return }
          if (method === 0xff) { fail(socksError('No acceptable authentication method', 'UND_ERR_SOCKS5_AUTH_REJECTED')); return }
          if (method === 0x02) {
            if (!hasAuth) { fail(socksError('Username and password required', 'UND_ERR_SOCKS5_AUTH_FAILED')); return }
            state = 'auth'
            const authPacket = Buffer.alloc(3 + userBytes.length + passBytes.length)
            authPacket[0] = 0x01
            authPacket[1] = userBytes.length
            userBytes.copy(authPacket, 2)
            authPacket[2 + userBytes.length] = passBytes.length
            passBytes.copy(authPacket, 3 + userBytes.length)
            socket.write(authPacket)
            continue
          }
          if (method === 0x00) {
            state = 'connect'
            socket.write(connectRequest)
            continue
          }
          fail(socksError(`Unsupported authentication method: ${method}`, 'UND_ERR_SOCKS5_AUTH_METHOD'))
          return
        }
        if (state === 'auth') {
          if (buffered.length < 2) return
          const version = buffered[0]!
          const status = buffered[1]!
          buffered = buffered.subarray(2)
          if (version !== 0x01) { fail(socksError(`Invalid auth version: ${version}`, 'UND_ERR_SOCKS5_AUTH_VERSION')); return }
          if (status !== 0x00) { fail(socksError('SOCKS5 authentication failed', 'UND_ERR_SOCKS5_AUTH_FAILED')); return }
          state = 'connect'
          socket.write(connectRequest)
          continue
        }
        if (buffered.length < 4) return
        const version = buffered[0]!
        const reply = buffered[1]!
        const addressType = buffered[3]!
        if (version !== 0x05) { fail(socksError(`Invalid SOCKS reply version: ${version}`, 'UND_ERR_SOCKS5_REPLY_VERSION')); return }
        let responseLength: number
        if (addressType === 0x01) responseLength = 10
        else if (addressType === 0x03) {
          if (buffered.length < 5) return
          responseLength = 5 + buffered[4]! + 2
        } else if (addressType === 0x04) responseLength = 22
        else { fail(socksError(`Invalid address type in reply: ${addressType}`, 'UND_ERR_SOCKS5_ADDR_TYPE')); return }
        if (buffered.length < responseLength) return
        if (reply !== 0x00) { fail(socksError(`SOCKS5 connection failed: reply ${reply}`, `UND_ERR_SOCKS5_REPLY_${reply}`)); return }
        succeed(buffered.subarray(responseLength))
        return
      }
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      fail(Object.assign(new Error('代理请求建立超时'), { code: 'UND_ERR_PROXY_HANDSHAKE_TIMEOUT' }))
    }, timeoutMs) : undefined
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.write(Buffer.from(hasAuth ? [0x05, 0x02, 0x02, 0x00] : [0x05, 0x01, 0x00]))
  })
}

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

/** Own pending proxy sockets so abandoned handshakes tear down deterministically. */
class ManagedProxyDispatcher extends Dispatcher {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  constructor(
    private readonly inner: Dispatcher,
    private readonly sockets: Set<Socket>,
    private readonly connectTimeoutMs: number,
    private readonly requestTimeoutMs: number,
    private readonly pending: AsyncLocalStorage<PendingConnection>,
  ) { super() }
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const owner: PendingConnection = { sockets: new Set() }
    let completed = false
    let cancelled = false
    let abortTransport: ((reason?: Error) => void) | undefined
    const clear = () => { if (timer) { clearTimeout(timer); this.timers.delete(timer) } }
    const finish = () => { if (!completed) { completed = true; clear() } }
    const releasePending = (error: Error) => { for (const socket of owner.sockets) safeDestroySocket(socket, error); owner.sockets.clear() }
    const cancel = (error: Error) => {
      if (completed) return
      if (abortTransport) { abortTransport(error); return }
      cancelled = true; owner.cancelled = error; finish(); releasePending(error)
      if (handler.onError) handler.onError(error)
      else if (handler.onResponseError) Reflect.apply(handler.onResponseError, handler, [undefined, error])
    }
    const timer = this.connectTimeoutMs > 0 ? setTimeout(() => {
      const error = Object.assign(new Error('代理请求建立超时'), { code: 'UND_ERR_PROXY_HANDSHAKE_TIMEOUT' })
      cancel(error)
    // Let the connector report its marked TCP/DNS timeout before the broader
    // handshake deadline. A tunnel or source timeout must never trigger fallback.
    }, Math.min(2_147_483_647, this.connectTimeoutMs + 100)) : undefined
    if (timer) this.timers.add(timer)
    // Fetch normally receives its abort callback only after the tunnel connects.
    // Register cancellation now so an abandoned proxy handshake cannot outlive it.
    const earlyConnect = typeof handler.onConnect === 'function' && typeof handler.onRequestStart !== 'function'
    const clearOnConnect = this.requestTimeoutMs === 0
    if (earlyConnect) handler.onConnect!((reason?: Error) => cancel(reason ?? Object.assign(new Error('代理请求已取消'), { name: 'AbortError' })))
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
          if (clearOnConnect) clear()
          if (cancelled) abortTransport(Object.assign(new Error('代理请求已取消'), { name: 'AbortError' }))
          return
        }
        if (name === 'onRequestStart') {
          owner.sockets.clear()
          if (clearOnConnect) clear()
        }
        if (cancelled) return
        if (name === 'onHeaders' || name === 'onResponseStart' || name === 'onUpgrade' || name === 'onRequestUpgrade') clear()
        if (name === 'onComplete' || name === 'onResponseEnd' || name === 'onUpgrade' || name === 'onRequestUpgrade') finish()
        if (name === 'onError' || name === 'onResponseError') {
          finish(); releasePending(new Error('代理连接已取消'))
        }
        return Reflect.apply(original, target, args)
      }
    } })
    try { return this.pending.run(owner, () => this.inner.dispatch(options, wrapped)) }
    catch (error) { finish(); releasePending(new Error('代理请求失败')); throw error }
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
    const reason = typeof errorOrCallback === 'function' ? null : errorOrCallback ?? null
    const pending = this.inner.destroy(reason).finally(() => this.release(reason ?? undefined))
    const done = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    if (done) { void pending.then(done, done); return }
    return pending
  }
  private release(error?: Error): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const socket of this.sockets) safeDestroySocket(socket, error)
    this.sockets.clear()
  }
}

export function createProxyDispatcher(
  route: NetworkRoute,
  timeoutMs: number,
  connections = 1,
  tls: { verifyTls?: boolean; verifyProxyTls?: boolean } = {},
  maxHeaderSize?: number,
  keepAliveTimeout = DEFAULT_PROXY_KEEP_ALIVE_TIMEOUT_MS,
  allowH2 = false,
): Dispatcher {
  if ((route.kind !== 'http' && route.kind !== 'socks5') || !route.proxyUrl) throw new Error('系统代理类型不受支持')
  const proxy = new URL(route.proxyUrl)
  if (!(route.kind === 'http' ? ['http:', 'https:'] : ['socks5:']).includes(proxy.protocol)
    || !proxy.hostname || !['', '/'].includes(proxy.pathname) || proxy.search || proxy.hash) throw new Error('系统代理地址无效')
  const connectTimeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS
  const keepAliveMaxTimeout = Math.max(keepAliveTimeout, DEFAULT_PROXY_KEEP_ALIVE_TIMEOUT_MS)
  const sockets = new Set<Socket>()
  const pending = new AsyncLocalStorage<PendingConnection>()
  const literalIp = isIP(proxy.hostname.replace(/^\[|\]$/g, '')) !== 0
  const connect = buildConnector({
    timeout: connectTimeoutMs,
    rejectUnauthorized: tls.verifyProxyTls !== false,
    autoSelectFamily: !literalIp,
    ...(literalIp ? {} : { autoSelectFamilyAttemptTimeout: Math.max(10, Math.min(connectTimeoutMs, AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS)) }),
  })
  const trackSocket = (socket: Socket, owner?: PendingConnection): void => {
    sockets.add(socket)
    owner?.sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); owner?.sockets.delete(socket) })
  }
  const tracked: buildConnector.connector = (options, callback) => {
    const owner = pending.getStore()
    if (owner?.cancelled) { queueMicrotask(() => callback(owner.cancelled!, null)); return }
    const socket = connect(options, (error, connected) => {
      if (error) {
        if (CONNECT_CODES.has(String((error as NodeJS.ErrnoException).code))) markProxyConnectFailure(error)
        callback(error, null)
      } else callback(null, connected)
    }) as unknown as Socket
    trackSocket(socket, owner)
  }
  const sharedPoolSettings = {
    connections,
    headersTimeout: timeoutMs,
    bodyTimeout: 0,
    keepAliveTimeout,
    keepAliveMaxTimeout,
    ...(allowH2 ? { allowH2: true } : {}),
    ...(maxHeaderSize === undefined ? {} : { maxHeaderSize }),
  }
  let inner: Dispatcher
  if (route.kind === 'socks5') {
    const endpointConnect = buildConnector({
      rejectUnauthorized: tls.verifyTls !== false,
      timeout: connectTimeoutMs,
      ...(allowH2 ? { allowH2: true } : {}),
    })
    inner = new Agent({
      ...sharedPoolSettings,
      connect: (opts, callback) => {
        const owner = pending.getStore()
        if (owner?.cancelled) { queueMicrotask(() => callback(owner.cancelled!, null)); return }
        const targetPort = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80)
        void establishSocks5Tunnel(proxy, tracked, opts.hostname, targetPort, connectTimeoutMs).then(socket => {
          if (owner?.cancelled) {
            safeDestroySocket(socket, owner.cancelled)
            callback(owner.cancelled, null)
            return
          }
          if (opts.protocol !== 'https:') { callback(null, socket); return }
          const bareHost = opts.hostname.replace(/^\[|\]$/g, '')
          const servername = opts.servername || (isIP(bareHost) === 0 ? opts.hostname : undefined)
          const tlsSocket = endpointConnect({
            ...opts,
            ...(servername ? { servername } : {}),
            httpSocket: socket,
          }, callback) as unknown as Socket
          trackSocket(tlsSocket, owner)
        }, error => {
          callback(error instanceof Error ? error : new Error(String(error)), null)
        })
      },
    })
  } else {
    inner = new ProxyAgent({
      ...sharedPoolSettings,
      uri: proxy.href,
      requestTls: {
        rejectUnauthorized: tls.verifyTls !== false,
        timeout: connectTimeoutMs,
        ...(allowH2 ? { allowH2: true } : {}),
      },
      proxyTls: { rejectUnauthorized: tls.verifyProxyTls !== false, timeout: connectTimeoutMs },
      // Use Pool so concurrent CONNECT tunnel setups do not serialize behind a single Client.
      // Keep the proxy hop on HTTP/1.1 since local proxy servers negotiate CONNECT over HTTP/1.1.
      clientFactory: (origin, options) => new Pool(origin, {
        ...options,
        allowH2: false,
        connect: tracked,
        headersTimeout: connectTimeoutMs,
        keepAliveTimeout,
        keepAliveMaxTimeout,
        ...(maxHeaderSize === undefined ? {} : { maxHeaderSize }),
      }),
    })
  }
  return new ManagedProxyDispatcher(inner, sockets, connectTimeoutMs, timeoutMs, pending)
}
