/** Opaque, bounded media capabilities. Only main-resolved URLs enter this registry. */
import { createHash, randomUUID } from 'node:crypto'
import { mediaRequestPolicy, type ProxyConfig } from './config'
import { mediaChild, mediaEntry, type MediaAccess, type MediaAccessScope } from './mediaAccess'
import { rewritePlaylist, shouldRewrite } from './hlsRewrite'
import type { NetworkContext } from './networkPolicy'
import { classifyNetworkFailure, StreamFailureError, type StreamFailure } from './networkFailure'
import { hasSensitiveHeaders, PinnedDispatcherPool, ProxyError, safeFetch, type Resolver } from './safeFetch'
import { mediaUrlCredentials, withoutSourceCredentials } from './mediaCredentials'

export const MEDIA_ORIGIN = 'app://app'
const MAX_PLAYLIST_BYTES = 4 * 1_048_576
const MAX_RESOURCES = 8192
const TTL_MS = 10 * 60_000
const MAX_UPSTREAM_RETRIES = 2
const TRANSIENT_UPSTREAM_STATUSES = new Set([500, 502, 503, 504])
const TRANSIENT_SOCKET_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_PREMATURE_CLOSE'])
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']
class MediaCapacityError extends Error {}
export interface MediaDeps {
  config: ProxyConfig
  resolve?: Resolver
  fetchImpl?: typeof fetch
  now?: () => number
  network?: NetworkContext
  publicOrigin?: string
  maxResources?: number
  onFailure?: (failure: StreamFailure, network?: NetworkContext) => void
  /** Observed media bytes delivered to the consumer, excluding rewritten playlists. */
  onBytes?: (bytes: number, network?: NetworkContext) => void
  /** Decoded HLS playlist body before URI rewriting, scoped to the request's network context. */
  onPlaylist?: (playlist: { url: string | URL; body: string }, network?: NetworkContext) => void
}
type Resource = { url: string; touched: number; headers?: Record<string,string>; network?: NetworkContext; access: MediaAccess; identity: string; children: Set<string>; readers: number }

export class MediaRegistry {
  private readonly resources = new Map<string, Resource>()
  private readonly ids = new Map<string, string>()
  private readonly pool = new PinnedDispatcherPool({ maxEntries: 16, connections: 4 })
  private readonly requests = new Set<AbortController>()
  private readonly roots = new Set<string>()
  private readonly pendingChildren = new Set<string>()
  private readonly owners = new Map<AbortSignal, { ids: Set<string>; abort: () => void }>()
  private closed = false
  constructor(private readonly deps: MediaDeps) {
    if (deps.maxResources !== undefined && (!Number.isSafeInteger(deps.maxResources) || deps.maxResources < 1)) throw new Error('Invalid media memory capacity')
  }
  register = (raw: string, headers?: Record<string,string>, network?: NetworkContext, access?: MediaAccess): string =>
    this.registerResource(raw, headers, network, access ?? mediaEntry(raw), true)

  private registerResource(raw: string, headers: Record<string,string> | undefined, network: NetworkContext | undefined, access: MediaAccess, root = false): string {
    if (this.closed) throw new Error('媒体读取服务已关闭')
    const prepared = network?.media ? mediaUrlCredentials(raw, headers) : undefined
    const url = prepared?.url ?? new URL(raw)
    if (prepared && Object.keys(prepared.headers).length) headers = prepared.headers
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的媒体地址')
    url.hash = ''
    const value = url.toString()
    const identity = JSON.stringify([value, headers, this.contextId(network), access.entry ? 'entry' : this.scopeId(access.scope)])
    const now = this.now()
    this.prune(now)
    const existing = this.ids.get(identity)
    if (existing) {
      const resource = this.resources.get(existing)!
      resource.touched = now
      this.resources.delete(existing)
      this.resources.set(existing, resource)
      if (root && network?.signal && !network.signal.aborted) this.roots.add(existing)
      return `${this.deps.publicOrigin ?? MEDIA_ORIGIN}/media/${existing}`
    }
    const maxResources = this.deps.maxResources ?? MAX_RESOURCES
    if (this.resources.size >= maxResources) {
      const protectedIds = this.protectedResources()
      for (const id of this.resources.keys()) {
        if (!protectedIds.has(id)) this.remove(id)
        if (this.resources.size < maxResources) break
      }
      if (this.resources.size >= maxResources) throw new MediaCapacityError('Media registry memory capacity exhausted')
    }
    const id = randomUUID()
    this.ids.set(identity, id)
    this.resources.set(id, { url: value, touched: now, headers, network, access, identity, children: new Set(), readers: 0 })
    if (network?.signal) {
      const signal = network.signal
      let owner = this.owners.get(signal)
      if (!owner) {
        const ids = new Set<string>()
        const abort = () => { for (const owned of ids) this.remove(owned); this.owners.delete(signal) }
        owner = { ids, abort }; this.owners.set(signal, owner)
        signal.addEventListener('abort', abort, { once: true })
      }
      owner.ids.add(id)
      if (root && !signal.aborted) this.roots.add(id)
      if (signal.aborted) owner.abort()
    }
    return `${this.deps.publicOrigin ?? MEDIA_ORIGIN}/media/${id}`
  }
  private readonly contextIds = new WeakMap<NetworkContext, number>()
  private readonly scopeIds = new WeakMap<MediaAccessScope, number>()
  private nextScopeId = 0
  private nextContextId = 0
  private contextId(value?: NetworkContext): number {
    if (!value) return 0
    let id = this.contextIds.get(value)
    if (!id) { id = ++this.nextContextId; this.contextIds.set(value, id) }
    return id
  }
  private scopeId(scope: MediaAccessScope): number {
    let id = this.scopeIds.get(scope)
    if (!id) { id = ++this.nextScopeId; this.scopeIds.set(scope, id) }
    return id
  }
  clear(): void {
    for (const [signal, owner] of this.owners) signal.removeEventListener('abort', owner.abort)
    this.owners.clear(); this.roots.clear(); this.pendingChildren.clear(); this.resources.clear(); this.ids.clear()
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const controller of this.requests) controller.abort()
    this.clear()
    await this.pool.dispose()
  }

  async handle(request: Request): Promise<Response> {
    if (this.closed) return errorResponse(503, 'media-disabled', '媒体读取服务已关闭')
    if (!['GET', 'HEAD'].includes(request.method)) return errorResponse(405, 'bad-method', '仅支持读取媒体')
    const url = new URL(request.url)
    if (url.protocol !== 'app:' || url.hostname !== 'app' || url.port || url.search || url.username || url.password) return errorResponse(403, 'unregistered-media', '媒体未登记')
    this.prune(this.now())
    const match = /^\/media\/([0-9a-f-]{36})$/.exec(url.pathname)
    const resource = match ? this.resources.get(match[1]!) : undefined
    if (!resource) return errorResponse(404, 'unregistered-media', '媒体未登记或已过期')
    resource.touched = this.now()
    if (!this.deps.config.enabled) return errorResponse(503, 'media-disabled', '远程媒体读取已关闭')
    const controller = new AbortController()
    resource.readers++
    this.requests.add(controller)
    const abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) controller.abort()
    const timeoutAbort = () => controller.abort(new DOMException('媒体读取超时', 'TimeoutError'))
    const configuredTimeout = (resource.network ?? this.deps.network)?.media?.requestTimeoutMs
    const timeoutMs = configuredTimeout === undefined ? this.deps.config.requestTimeoutMs
      : configuredTimeout > 0 ? configuredTimeout : 20_000
    let timeout = timeoutMs > 0 ? setTimeout(timeoutAbort, timeoutMs) : undefined
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true; resource.readers--
      clearTimeout(timeout); request.signal.removeEventListener('abort', abort); this.requests.delete(controller)
    }
    let upstream: Response | undefined
    const notifyFailure = (error: unknown) => {
      if (request.signal.aborted) return
      this.deps.onFailure?.(classifyNetworkFailure(controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason : error), resource.network ?? this.deps.network)
    }
    const notifyBytes = (bytes: number) => this.deps.onBytes?.(bytes, resource.network ?? this.deps.network)
    try {
      const headers: Record<string, string> = { 'user-agent': 'StreamSyncer/0.1 (+desktop)', 'accept-encoding': 'identity' }
      for (const name of ['range', 'accept', 'if-none-match']) {
        const value = request.headers.get(name)
        if (value) headers[name] = value
      }
      const host = new URL(resource.url).hostname
      if (/(^|\.)(douyucdn[23]?\.cn|dyscdn\.com|douyu\.com)$/i.test(host)) headers.referer = 'https://www.douyu.com/'
      if (/(^|\.)(bilivideo\.com|hdslb\.com)$/i.test(host)) headers.referer = 'https://live.bilibili.com/'
      if (/(^|\.)huya\.com$/i.test(host)) headers.referer = 'https://www.huya.com/'
      for (const [name, value] of Object.entries(resource.headers ?? {})) {
        for (const existing of Object.keys(headers)) {
          if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
        }
        headers[name] = value
      }
      // FFmpeg probes HTTP inputs with Range. Playlists need a complete body so
      // every nested URL can be replaced before reaching the local consumer.
      if (request.method === 'GET' && shouldRewrite(resource.url, null)) delete headers.range
      const connectionScope = JSON.stringify([this.contextId(resource.network ?? this.deps.network),
        createHash('sha256').update(JSON.stringify(Object.entries(resource.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')])
      const fetchResource = (usePool: boolean) => safeFetch(resource.url, mediaRequestPolicy(this.deps.config), {
        method: request.method, headers, signal: controller.signal, resolve: this.deps.resolve, fetchImpl: this.deps.fetchImpl, network: resource.network ?? this.deps.network,
        mediaAccess: resource.access, ...(usePool ? { dispatcherPool: this.pool, connectionScope } : {}),
      })
      const fetchWithRetry = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            // Attempt 0 reuses the connection pool; retries bypass it to avoid stale sockets.
            const fetched = await fetchResource(attempt === 0)
            if (TRANSIENT_UPSTREAM_STATUSES.has(fetched.response.status)
              && attempt < MAX_UPSTREAM_RETRIES && !controller.signal.aborted) {
              await fetched.response.body?.cancel().catch(() => {})
              await abortableDelay(150 * (attempt + 1), controller.signal)
              continue
            }
            return fetched
          } catch (error) {
            if (attempt >= MAX_UPSTREAM_RETRIES || controller.signal.aborted || !isRetryableUpstreamError(error)) throw error
            await abortableDelay(attempt === 0 ? 0 : 150 * attempt, controller.signal)
          }
        }
      }
      let result = await fetchWithRetry()
      upstream = result.response
      let upstreamBody: ReadableStream<Uint8Array> | null = upstream.body
      let playlist = false
      if (request.method === 'GET' && upstream.ok && upstreamBody) {
        let sniffed = await sniffPlaylist(upstreamBody)
        upstreamBody = sniffed.body
        if (sniffed.playlist && upstream.status === 206 && headers.range) {
          await upstreamBody.cancel().catch(() => {})
          delete headers.range
          result = await fetchWithRetry()
          upstream = result.response
          if (upstream.body) {
            sniffed = await sniffPlaylist(upstream.body)
            upstreamBody = sniffed.body
          } else { upstreamBody = null; sniffed.playlist = false }
        }
        playlist = sniffed.playlist && upstream.ok
        if (playlist && upstream.status === 206) {
          await upstreamBody?.cancel().catch(() => {})
          throw new ProxyError('upstream-failed', '媒体服务器未返回完整的 HLS 播放列表', 502)
        }
      }
      if (!upstream.ok) notifyFailure({ status: upstream.status })
      const outgoing = new Headers({ 'cache-control': 'no-store' })
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value !== null) outgoing.set(name, value)
      }
      if (upstream.headers.has('content-encoding')) outgoing.delete('content-length')
      if (request.method === 'HEAD' || !upstreamBody || [204, 205, 304].includes(upstream.status)) {
        await upstreamBody?.cancel()
        cleanup()
        return new Response(null, { status: upstream.status, headers: outgoing })
      }
      const type = upstream.headers.get('content-type') ?? ''
      if (playlist) {
        const bytes = await readBounded(upstreamBody, MAX_PLAYLIST_BYTES)
        const body = new TextDecoder().decode(bytes)
        cleanup()
        if (shouldRewrite(result.finalUrl, type, body)) {
          try { this.deps.onPlaylist?.({ url: result.finalUrl, body }, resource.network ?? this.deps.network) } catch { /* Diagnostics cannot interrupt media delivery. */ }
          const nextChildren = new Set<string>()
          let rewritten: string
          try {
            rewritten = rewritePlaylist(body, { baseUrl: result.finalUrl, register: raw => {
              const crossOrigin = new URL(raw).origin !== new URL(resource.url).origin
              if (crossOrigin && hasSensitiveHeaders(resource.headers) && !resource.network?.media) throw new ProxyError('cross-origin-credentials', '禁止将平台登录信息发送到其他来源', 403)
              const childHeaders = crossOrigin ? withoutSourceCredentials(resource.headers) : resource.headers
              const capability = this.registerResource(raw, childHeaders, resource.network, mediaChild(resource.access))
              const id = capability.slice(capability.lastIndexOf('/') + 1)
              nextChildren.add(id); this.pendingChildren.add(id)
              return capability
            } })
            resource.children = nextChildren
          } finally { for (const id of nextChildren) this.pendingChildren.delete(id) }
          outgoing.set('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
          outgoing.set('content-length', String(Buffer.byteLength(rewritten)))
          outgoing.delete('content-range')
          outgoing.delete('etag')
          return new Response(rewritten, { status: 200, headers: outgoing })
        }
        outgoing.set('content-length', String(bytes.byteLength))
        try { notifyBytes(bytes.byteLength) } catch { /* Metrics cannot interrupt media delivery. */ }
        return new Response(bytes, { status: upstream.status, headers: outgoing })
      }
      const reader = upstreamBody.getReader()
      const idleTimeoutMs = timeoutMs
      // Continuous FLV has no end-of-body. Limit upstream inactivity only while
      // awaiting bytes; downstream backpressure must not consume that budget.
      clearTimeout(timeout)
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          timeout = idleTimeoutMs > 0 ? setTimeout(timeoutAbort, idleTimeoutMs) : undefined
          try {
            const chunk = await reader.read()
            clearTimeout(timeout)
            if (chunk.done) { cleanup(); stream.close() }
            else {
              try { notifyBytes(chunk.value.byteLength) } catch { /* Metrics cannot interrupt media delivery. */ }
              stream.enqueue(chunk.value)
            }
          } catch (error) { notifyFailure(error); cleanup(); stream.error(new Error('媒体读取中断')) }
        },
        async cancel() { controller.abort(); cleanup(); await reader.cancel().catch(() => {}) },
      })
      return new Response(body, { status: upstream.status, headers: outgoing })
    } catch (error) {
      notifyFailure(error)
      const timedOut = controller.signal.aborted
      controller.abort()
      await upstream?.body?.cancel().catch(() => {})
      cleanup()
      if (error instanceof ProxyError) return errorResponse(error.status, error.reason, classifyNetworkFailure(error).message)
      if (error instanceof MediaCapacityError) return errorResponse(503, 'media-capacity', '媒体登记内存容量已用尽，请关闭不用的片源')
      if (error instanceof RangeError) return errorResponse(413, 'too-large', '媒体清单超过大小上限')
      return errorResponse(timedOut ? 504 : 502, timedOut ? 'upstream-timeout' : 'upstream-failed', '媒体读取失败')
    }
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private remove(id: string): void {
    const resource = this.resources.get(id)
    if (resource) this.ids.delete(resource.identity)
    this.resources.delete(id)
    this.roots.delete(id)
    this.pendingChildren.delete(id)
    if (resource?.network?.signal) this.owners.get(resource.network.signal)?.ids.delete(id)
  }
  private prune(now: number): void {
    const protectedIds = this.protectedResources()
    for (const [id, resource] of this.resources) if (!protectedIds.has(id) && now - resource.touched > TTL_MS) this.remove(id)
  }
  private protectedResources(): Set<string> {
    const retained = new Set<string>()
    const pending = [...this.roots, ...this.pendingChildren]
    for (const [id, resource] of this.resources) if (resource.readers > 0) pending.push(id)
    while (pending.length) {
      const id = pending.pop()!
      if (retained.has(id)) continue
      const resource = this.resources.get(id)
      if (!resource) continue
      retained.add(id); pending.push(...resource.children)
    }
    return retained
  }
}

/** Inspect a bounded prefix; mislabeled binary streams must not hit the playlist body cap. */
async function sniffPlaylist(body: ReadableStream<Uint8Array>): Promise<{ playlist: boolean; body: ReadableStream<Uint8Array> }> {
  const reader = body.getReader()
  const prefix: Uint8Array[] = []
  let sample = Buffer.alloc(0)
  let done = false
  let playlist = false
  try {
    while (sample.length < 512) {
      const chunk = await reader.read()
      if (chunk.done) { done = true; break }
      if (!chunk.value.byteLength) continue
      prefix.push(chunk.value)
      sample = Buffer.concat([sample, chunk.value.subarray(0, 512 - sample.length)])
      const text = new TextDecoder().decode(sample).replace(/^\uFEFF/, '').trimStart()
      if (text.startsWith('#EXTM3U')) { playlist = true; break }
      if (text && !'#EXTM3U'.startsWith(text) && ![0xef, 0xbb].includes(sample.at(-1)!)) break
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  if (!playlist && sample.length >= 512 && '#EXTM3U'.startsWith(new TextDecoder().decode(sample).replace(/^\uFEFF/, '').trimStart())) {
    await reader.cancel().catch(() => {})
    throw new ProxyError('upstream-failed', '媒体响应头部超过可识别范围', 502)
  }
  let index = 0
  return { playlist, body: new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) { controller.enqueue(prefix[index++]!); return }
      if (done) { reader.releaseLock(); controller.close(); return }
      try {
        const next = await reader.read()
        if (next.done) { done = true; reader.releaseLock(); controller.close() }
        else controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  }) }
}

async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) throw new RangeError('playlist limit')
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
function isRetryableUpstreamError(error: unknown): boolean {
  if (error instanceof ProxyError) return false
  if (error instanceof StreamFailureError) {
    if (error.failure.stage === 'resolve' || error.failure.stage === 'http') return false
    if (['tls-certificate', 'tls-failed', 'proxy-rejected', 'socks4-unsupported', 'proxy-type-unsupported', 'dns-failed', 'connection-timeout'].includes(error.failure.code)) {
      return false
    }
  }
  const pending: unknown[] = [error]
  const seen = new Set<object>()
  let retryable = false
  while (pending.length && seen.size < 32) {
    const value = pending.shift()
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const item = value as { name?: unknown; code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; cause?: unknown; errors?: unknown; failure?: { detail?: unknown } }
    if (item.name === 'AbortError' || item.name === 'TimeoutError' || item.name === 'ProxyError') return false
    const code = typeof item.code === 'string' ? item.code : ''
    if (/CERT|TLS|SSL|AUTH|REJECT|SOCKS5_|PROXY_HANDSHAKE_TIMEOUT|ENOTFOUND|EAI_AGAIN|TIMEOUT|ETIMEDOUT/i.test(code)
      || item.status !== undefined || item.statusCode !== undefined) return false
    const message = typeof item.message === 'string' ? item.message : ''
    if (TRANSIENT_SOCKET_CODES.has(code)
      || /\b(?:ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)\b|other side closed|socket hang up|connection reset|connection aborted|broken pipe/i.test(message)) {
      retryable = true
    }
    if (item.cause !== undefined) pending.push(item.cause)
    if (item.failure?.detail !== undefined) pending.push(item.failure.detail)
    if (Array.isArray(item.errors)) pending.push(...item.errors)
  }
  return retryable
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return signal.aborted ? Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) : Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}
