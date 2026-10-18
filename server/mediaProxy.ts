/**
 * Same-origin media proxy.
 *
 * Purpose: platform CDNs do not send permissive CORS headers, so a cross-origin
 * `<video>`/hls.js load either fails or (for the canvas) taints the frame and blocks
 * countdown recognition. Fetching server-side and re-serving from our own origin fixes
 * both: the browser sees one origin, and `getImageData` stays legal.
 *
 * Deliberately NOT done here (all present in the reference implementation this project
 * only draws ideas from):
 *   - accepting a client-supplied `Referer`/`Origin` to spoof a platform's checks
 *   - forwarding cookies or auth headers to arbitrary targets
 *   - buffering whole responses in memory
 *   - routing through third-party public CORS proxies
 * Each is an SSRF, credential-leak, memory or supply-chain hazard for a service
 * listening on the user's machine.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ProxyConfig } from './config'
import { rewritePlaylist, shouldRewrite } from './hlsRewrite'
import { sendError } from './http'
import { ProxyError, safeFetch, type Resolver } from './safeFetch'

export const PROXY_PATH = '/api/proxy'

/** Response headers worth passing through; everything else is dropped. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
]

/** Request headers worth passing upstream. Notably absent: cookie, authorization. */
const FORWARDED_REQUEST_HEADERS = ['range', 'accept', 'accept-encoding', 'if-none-match']

/** A playlist above this size is not a playlist; refuse rather than buffer it. */
const MAX_PLAYLIST_BYTES = 4 * 1_048_576

export type ProxyDeps = {
  config: ProxyConfig
  resolve?: Resolver
  fetchImpl?: typeof fetch
}

export async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ProxyDeps,
): Promise<void> {
  if (!deps.config.enabled) {
    sendError(res, 503, 'proxy-disabled', '媒体代理已关闭，请设置 STREAM_SYNC_MEDIA_PROXY_ENABLED=1')
    return
  }

  const target = url.searchParams.get('url')
  if (!target) {
    sendError(res, 400, 'missing-url', '缺少 url 参数')
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.config.requestTimeoutMs)
  // A client that navigates away or seeks again must not leave an upstream request open.
  const onClose = () => controller.abort()
  res.on('close', onClose)

  try {
    const { response, finalUrl } = await safeFetch(target, deps.config, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: pickRequestHeaders(req),
      signal: controller.signal,
      resolve: deps.resolve,
      fetchImpl: deps.fetchImpl,
    })

    const contentType = response.headers.get('content-type')
    const contentLength = Number(response.headers.get('content-length') ?? '0')

    // Playlists must be read and rewritten; media is streamed straight through.
    if (
      req.method !== 'HEAD' &&
      response.ok &&
      contentLength <= MAX_PLAYLIST_BYTES &&
      looksLikePlaylist(finalUrl, contentType)
    ) {
      const body = await response.text()
      if (shouldRewrite(finalUrl.toString(), contentType, body)) {
        const rewritten = rewritePlaylist(body, {
          baseUrl: finalUrl.toString(),
          proxyPath: PROXY_PATH,
        })
        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'content-length': Buffer.byteLength(rewritten),
          // Live playlists change constantly; a cached one stalls playback.
          'cache-control': 'no-store',
          'access-control-allow-origin': 'same-origin',
        })
        res.end(rewritten)
        return
      }
      // Not actually a playlist: hand back what we read.
      res.writeHead(response.status, forwardedHeaders(response, Buffer.byteLength(body)))
      res.end(body)
      return
    }

    res.writeHead(response.status, forwardedHeaders(response))
    if (req.method === 'HEAD' || !response.body) {
      res.end()
      return
    }
    // Stream: a 4 GiB VOD segment run must never accumulate in this process.
    await pipeBody(response.body, res)
  } catch (error) {
    if (controller.signal.aborted && !res.headersSent) {
      sendError(res, 504, 'upstream-timeout', '上游响应超时')
      return
    }
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (error instanceof ProxyError) {
      sendError(res, error.status, error.reason, error.message)
      return
    }
    sendError(
      res,
      502,
      'upstream-failed',
      `上游请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timeout)
    res.off('close', onClose)
  }
}

async function pipeBody(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
  try {
    for await (const chunk of stream) {
      if (res.writableEnded) break
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
  } catch {
    // Client hung up mid-segment; nothing recoverable, and the socket is already gone.
    res.destroy()
  }
}

/**
 * Cheap pre-filter deciding whether a response is worth buffering to look at. A false
 * positive costs one small read (`shouldRewrite` then sniffs the body and says no); a
 * false negative would stream an unrewritten playlist, so this leans permissive.
 */
function looksLikePlaylist(url: URL, contentType: string | null): boolean {
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('mpegurl') || type.includes('m3u')) return true
  const path = url.pathname.toLowerCase()
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return true
  // Segments are the hot path and are never playlists; skip them without reading.
  if (path.endsWith('.ts') || path.endsWith('.m4s') || path.endsWith('.mp4')) return false
  if (type.startsWith('video/') || type.startsWith('audio/')) return false
  // Extensionless or text/plain: worth reading, `shouldRewrite` makes the final call.
  return type.includes('text') || type.includes('octet-stream') || !path.includes('.')
}

function pickRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    // A neutral, honest UA. Not a spoofed browser string aimed at bypassing checks.
    'user-agent': 'StreamSyncPlayer/0.1 (+local)',
  }
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}

function forwardedHeaders(response: Response, overrideLength?: number): Record<string, string> {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'access-control-allow-origin': 'same-origin',
  }
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  if (overrideLength !== undefined) headers['content-length'] = String(overrideLength)
  return headers
}
