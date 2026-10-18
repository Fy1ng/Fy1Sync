/** Opaque, bounded media capabilities. Only main-resolved URLs enter this registry. */
import { randomUUID } from 'node:crypto'
import type { ProxyConfig } from './config'
import { rewritePlaylist, shouldRewrite } from './hlsRewrite'
import { ProxyError, safeFetch, type Resolver } from './safeFetch'

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
}
type Resource = { url: string; touched: number }

export class MediaRegistry {
  private readonly resources = new Map<string, Resource>()
  private readonly ids = new Map<string, string>()
  constructor(private readonly deps: MediaDeps) {}
  register = (raw: string): string => {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的媒体地址')
    url.hash = ''
    const value = url.toString()
    const now = this.now()
    this.prune(now)
    const existing = this.ids.get(value)
    if (existing) {
      const resource = this.resources.get(existing)!
      resource.touched = now
      this.resources.delete(existing)
      this.resources.set(existing, resource)
      return `${MEDIA_ORIGIN}/media/${existing}`
    }
    while (this.resources.size >= MAX_RESOURCES) this.remove(this.resources.keys().next().value!)
    const id = randomUUID()
    this.ids.set(value, id)
    this.resources.set(id, { url: value, touched: now })
    return `${MEDIA_ORIGIN}/media/${id}`
  }
  clear(): void { this.resources.clear(); this.ids.clear() }

  async handle(request: Request): Promise<Response> {
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
    const abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) controller.abort()
    const timeout = setTimeout(abort, this.deps.config.requestTimeoutMs)
    const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abort) }
    let upstream: Response | undefined
    try {
      const headers: Record<string, string> = { 'user-agent': 'StreamSyncer/0.1 (+desktop)', 'accept-encoding': 'identity' }
      for (const name of ['range', 'accept', 'if-none-match']) {
        const value = request.headers.get(name)
        if (value) headers[name] = value
      }
      const host = new URL(resource.url).hostname
      if (/(^|\.)(douyucdn[23]?\.cn|dyscdn\.com|douyu\.com)$/.test(host)) headers.referer = 'https://www.douyu.com/'
      if (/(^|\.)(bilivideo\.com|hdslb\.com)$/.test(host)) headers.referer = 'https://live.bilibili.com/'
      const result = await safeFetch(resource.url, this.deps.config, {
        method: request.method, headers, signal: controller.signal, resolve: this.deps.resolve, fetchImpl: this.deps.fetchImpl,
      })
      upstream = result.response
      const outgoing = new Headers({ 'cache-control': 'no-store' })
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value !== null) outgoing.set(name, value)
      }
      if (upstream.headers.has('content-encoding')) outgoing.delete('content-length')
      if (request.method === 'HEAD' || !upstream.body || [204, 205, 304].includes(upstream.status)) {
        await upstream.body?.cancel()
        cleanup()
        return new Response(null, { status: upstream.status, headers: outgoing })
      }
      const type = upstream.headers.get('content-type') ?? ''
      const path = result.finalUrl.pathname.toLowerCase()
      const mediaExtension = /\.(?:ts|m4s|mp4|webm|aac|mp3)$/.test(path)
      const candidate = shouldRewrite(result.finalUrl, type) || (!mediaExtension && (
        type.includes('text') || type.includes('octet-stream') || (!path.includes('.') && !/^(video|audio)\//.test(type))
      ))
      if (upstream.ok && candidate && upstream.status !== 206) {
        const bytes = await readBounded(upstream.body, MAX_PLAYLIST_BYTES)
        const body = new TextDecoder().decode(bytes)
        cleanup()
        if (shouldRewrite(result.finalUrl, type, body)) {
          const rewritten = rewritePlaylist(body, { baseUrl: result.finalUrl, register: this.register })
          outgoing.set('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
          outgoing.set('content-length', String(Buffer.byteLength(rewritten)))
          outgoing.delete('content-range')
          outgoing.delete('etag')
          return new Response(rewritten, { status: 200, headers: outgoing })
        }
        outgoing.set('content-length', String(bytes.byteLength))
        return new Response(bytes, { status: upstream.status, headers: outgoing })
      }
      const reader = upstream.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const chunk = await reader.read()
            if (chunk.done) { cleanup(); stream.close() }
            else stream.enqueue(chunk.value)
          } catch { cleanup(); stream.error(new Error('媒体读取中断')) }
        },
        async cancel() { controller.abort(); cleanup(); await reader.cancel().catch(() => {}) },
      })
      return new Response(body, { status: upstream.status, headers: outgoing })
    } catch (error) {
      const timedOut = controller.signal.aborted
      controller.abort()
      await upstream?.body?.cancel().catch(() => {})
      cleanup()
      if (error instanceof ProxyError) return errorResponse(error.status, error.reason, '媒体目标被安全策略拒绝')
      if (error instanceof RangeError) return errorResponse(413, 'too-large', '媒体清单超过大小上限')
      return errorResponse(timedOut ? 504 : 502, timedOut ? 'upstream-timeout' : 'upstream-failed', '媒体读取失败')
    }
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private remove(id: string): void {
    const resource = this.resources.get(id)
    if (resource) this.ids.delete(resource.url)
    this.resources.delete(id)
  }
  private prune(now: number): void {
    for (const [id, resource] of this.resources) if (now - resource.touched > TTL_MS) this.remove(id)
  }
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
