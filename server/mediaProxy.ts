/** Opaque, bounded media capabilities. Only main-resolved URLs enter this registry. */
import { createHash, randomUUID } from 'node:crypto'
import { mediaRequestPolicy, type ProxyConfig } from './config'
import { mediaChild, mediaEntry, type MediaAccess, type MediaAccessScope } from './mediaAccess'
import { rewritePlaylist, shouldRewrite } from './hlsRewrite'
import type { NetworkContext } from './networkPolicy'
import { classifyNetworkFailure, type StreamFailure } from './networkFailure'
import { hasSensitiveHeaders, PinnedDispatcherPool, ProxyError, safeFetch, type Resolver } from './safeFetch'

export const MEDIA_ORIGIN = 'app://app'
const MAX_PLAYLIST_BYTES = 4 * 1_048_576
const MAX_RESOURCES = 8192
const TTL_MS = 10 * 60_000
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']
export interface MediaDeps {
  config: ProxyConfig
  resolve?: Resolver
  fetchImpl?: typeof fetch
  now?: () => number
  network?: NetworkContext
  publicOrigin?: string
  onFailure?: (failure: StreamFailure, network?: NetworkContext) => void
}
type Resource = { url: string; touched: number; headers?: Record<string,string>; network?: NetworkContext; access: MediaAccess; identity: string }

export class MediaRegistry {
  private readonly resources = new Map<string, Resource>()
  private readonly ids = new Map<string, string>()
  private readonly pool = new PinnedDispatcherPool({ maxEntries: 16, connections: 4 })
  private readonly requests = new Set<AbortController>()
  private closed = false
  constructor(private readonly deps: MediaDeps) {}
  register = (raw: string, headers?: Record<string,string>, network?: NetworkContext, access?: MediaAccess): string =>
    this.registerResource(raw, headers, network, access ?? mediaEntry(raw))

  private registerResource(raw: string, headers: Record<string,string> | undefined, network: NetworkContext | undefined, access: MediaAccess): string {
    if (this.closed) throw new Error('媒体读取服务已关闭.')
    const url = new URL(raw)
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
      return `${this.deps.publicOrigin ?? MEDIA_ORIGIN}/media/${existing}`
    }
    while (this.resources.size >= MAX_RESOURCES) this.remove(this.resources.keys().next().value!)
    const id = randomUUID()
    this.ids.set(identity, id)
    this.resources.set(id, { url: value, touched: now, headers, network, access, identity })
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
  clear(): void { this.resources.clear(); this.ids.clear() }

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
    this.requests.add(controller)
    const abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) controller.abort()
    const timeoutAbort = () => controller.abort(new DOMException('媒体读取超时.', 'TimeoutError'))
    let timeout = setTimeout(timeoutAbort, this.deps.config.requestTimeoutMs)
    const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); this.requests.delete(controller) }
    let upstream: Response | undefined
    const notifyFailure = (error: unknown) => {
      if (request.signal.aborted) return
      this.deps.onFailure?.(classifyNetworkFailure(controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason : error), resource.network ?? this.deps.network)
    }
    try {
      const headers: Record<string, string> = { 'user-agent': 'StreamSyncer/0.1 (+desktop)', 'accept-encoding': 'identity' }
      for (const name of ['range', 'accept', 'if-none-match']) {
        const value = request.headers.get(name)
        if (value) headers[name] = value
      }
      const host = new URL(resource.url).hostname
      if (/(^|\.)(douyucdn[23]?\.cn|dyscdn\.com|douyu\.com)$/.test(host)) headers.referer = 'https://www.douyu.com/'
      if (/(^|\.)(bilivideo\.com|hdslb\.com)$/.test(host)) headers.referer = 'https://live.bilibili.com/'
      Object.assign(headers, resource.headers)
      // FFmpeg probes HTTP inputs with Range. Playlists need a complete body so
      // every nested URL can be replaced before reaching the local consumer.
      if (request.method === 'GET' && shouldRewrite(resource.url, null)) delete headers.range
      const connectionScope = JSON.stringify([this.contextId(resource.network ?? this.deps.network),
        createHash('sha256').update(JSON.stringify(Object.entries(resource.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex')])
      const fetchResource = () => safeFetch(resource.url, mediaRequestPolicy(this.deps.config), {
        method: request.method, headers, signal: controller.signal, resolve: this.deps.resolve, fetchImpl: this.deps.fetchImpl, network: resource.network ?? this.deps.network,
        mediaAccess: resource.access, dispatcherPool: this.pool, connectionScope,
      })
      let result = await fetchResource()
      upstream = result.response
      let upstreamBody: ReadableStream<Uint8Array> | null = upstream.body
      let playlist = false
      if (request.method === 'GET' && upstream.ok && upstreamBody) {
        let sniffed = await sniffPlaylist(upstreamBody)
        upstreamBody = sniffed.body
        if (sniffed.playlist && upstream.status === 206 && headers.range) {
          await upstreamBody.cancel().catch(() => {})
          delete headers.range
          result = await fetchResource()
          upstream = result.response
          if (upstream.body) {
            sniffed = await sniffPlaylist(upstream.body)
            upstreamBody = sniffed.body
          } else { upstreamBody = null; sniffed.playlist = false }
        }
        playlist = sniffed.playlist && upstream.ok
        if (playlist && upstream.status === 206) {
          await upstreamBody?.cancel().catch(() => {})
          throw new ProxyError('upstream-failed', '媒体服务器未返回完整的 HLS 播放列表.', 502)
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
          const rewritten = rewritePlaylist(body, { baseUrl: result.finalUrl, register: raw => {
            if (new URL(raw).origin !== result.finalUrl.origin && hasSensitiveHeaders(resource.headers)) {
              throw new ProxyError('cross-origin-credentials', '禁止将平台登录信息发送到其他来源', 403)
            }
            return this.registerResource(raw, resource.headers, resource.network, mediaChild(resource.access))
          } })
          outgoing.set('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
          outgoing.set('content-length', String(Buffer.byteLength(rewritten)))
          outgoing.delete('content-range')
          outgoing.delete('etag')
          return new Response(rewritten, { status: 200, headers: outgoing })
        }
        outgoing.set('content-length', String(bytes.byteLength))
        return new Response(bytes, { status: upstream.status, headers: outgoing })
      }
      const reader = upstreamBody.getReader()
      const idleTimeoutMs = this.deps.config.requestTimeoutMs
      // Continuous FLV has no end-of-body. Limit upstream inactivity only while
      // awaiting bytes; downstream backpressure must not consume that budget.
      clearTimeout(timeout)
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          timeout = setTimeout(timeoutAbort, idleTimeoutMs)
          try {
            const chunk = await reader.read()
            clearTimeout(timeout)
            if (chunk.done) { cleanup(); stream.close() }
            else stream.enqueue(chunk.value)
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
      if (error instanceof RangeError) return errorResponse(413, 'too-large', '媒体清单超过大小上限')
      return errorResponse(timedOut ? 504 : 502, timedOut ? 'upstream-timeout' : 'upstream-failed', '媒体读取失败')
    }
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private remove(id: string): void {
    const resource = this.resources.get(id)
    if (resource) this.ids.delete(resource.identity)
    this.resources.delete(id)
  }
  private prune(now: number): void {
    for (const [id, resource] of this.resources) if (now - resource.touched > TTL_MS) this.remove(id)
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
    throw new ProxyError('upstream-failed', '媒体响应头部超过可识别范围.', 502)
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
function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}
