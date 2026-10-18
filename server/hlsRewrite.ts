/**
 * HLS playlist rewriting.
 *
 * Proxying only the top-level playlist is not enough: the browser would read it, then
 * fetch the sub-playlists, segments and AES keys *directly*, hitting CORS again. Every
 * URI inside a playlist therefore has to be rewritten to point back at this proxy,
 * absolutised against the playlist's own final URL first (post-redirect), or relative
 * segment names would resolve against the wrong base.
 *
 * Rewritten forms:
 *   - variant/rendition playlist URIs (`#EXT-X-STREAM-INF` lines, `#EXT-X-MEDIA` URI=)
 *   - media segment lines
 *   - `#EXT-X-KEY` / `#EXT-X-SESSION-KEY` URI= (AES-128 key files)
 *   - `#EXT-X-MAP` URI= (fMP4 init segments)
 *   - `#EXT-X-I-FRAME-STREAM-INF` URI=
 *   - `#EXT-X-PART` / `#EXT-X-PRELOAD-HINT` URI= (LL-HLS)
 */

export type RewriteOptions = {
  /** Absolute URL the playlist was actually loaded from, after redirects. */
  baseUrl: string | URL
  /** Proxy endpoint path, e.g. `/api/proxy`. */
  proxyPath: string
  /** Extra query params to preserve on every rewritten URL (e.g. platform hints). */
  extraQuery?: Record<string, string>
}

/** Tags whose `URI="..."` attribute points at something the proxy must also serve. */
const URI_ATTRIBUTE_TAGS = [
  '#EXT-X-KEY',
  '#EXT-X-SESSION-KEY',
  '#EXT-X-MAP',
  '#EXT-X-MEDIA',
  '#EXT-X-I-FRAME-STREAM-INF',
  '#EXT-X-PART',
  '#EXT-X-PRELOAD-HINT',
  '#EXT-X-RENDITION-REPORT',
]

/**
 * Whether a body is an HLS playlist, by its mandatory first line.
 *
 * The body is authoritative and the content type is not consulted: a CDN mislabelling an
 * `.mp4` as `application/vnd.apple.mpegurl` would otherwise get its binary run through
 * the line rewriter, which corrupts it. `#EXTM3U` is required by RFC 8216 §4.3.1.1, so
 * sniffing is reliable when a body is in hand.
 */
export function isPlaylistContent(body: string): boolean {
  // A UTF-8 BOM before #EXTM3U is out of spec but does occur in the wild.
  return body.replace(/^﻿/, '').trimStart().startsWith('#EXTM3U')
}

export function proxyUrlFor(target: string, options: RewriteOptions): string {
  const absolute = new URL(target, options.baseUrl).toString()
  const params = new URLSearchParams({ url: absolute })
  for (const [key, value] of Object.entries(options.extraQuery ?? {})) {
    params.set(key, value)
  }
  return `${options.proxyPath}?${params.toString()}`
}

/** Rewrite every URI in an HLS playlist to route through the proxy. */
export function rewritePlaylist(body: string, options: RewriteOptions): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      out.push(line)
      continue
    }
    if (trimmed.startsWith('#')) {
      out.push(rewriteTagLine(trimmed, options))
      continue
    }
    // A bare line is a segment or a sub-playlist; both go through the proxy.
    out.push(proxyUrlFor(trimmed, options))
  }

  return out.join('\n')
}

function rewriteTagLine(line: string, options: RewriteOptions): string {
  const tagName = line.split(':', 1)[0]!
  if (!URI_ATTRIBUTE_TAGS.includes(tagName)) return line
  return rewriteUriAttribute(line, options)
}

/**
 * Replace `URI="..."` inside an attribute list. Only the attribute value is touched;
 * quoting, ordering and unknown attributes are preserved so players that depend on
 * them (and CDNs that sign them) keep working.
 */
export function rewriteUriAttribute(line: string, options: RewriteOptions): string {
  return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => {
    if (uri.length === 0) return 'URI=""'
    return `URI="${escapeAttribute(proxyUrlFor(uri, options))}"`
  })
}

function escapeAttribute(value: string): string {
  // Quotes are the only character that could break out of an HLS attribute value.
  return value.replace(/"/g, '%22')
}

/**
 * Whether a proxied response should be treated as a playlist at all.
 *
 * With a body in hand the body decides, so an extensionless Twitch variant playlist
 * served as `text/plain` is rewritten and a mislabelled binary is not. Without a body
 * (a HEAD, or a response too large to buffer) it falls back to the content type and then
 * the path extension.
 */
export function shouldRewrite(
  url: string | URL,
  contentType: string | null,
  body?: string,
): boolean {
  if (body !== undefined) return isPlaylistContent(body)
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('mpegurl') || type.includes('m3u')) return true
  const path = safePath(url).toLowerCase()
  return path.endsWith('.m3u8') || path.endsWith('.m3u')
}

function safePath(url: string | URL): string {
  if (url instanceof URL) return url.pathname
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
