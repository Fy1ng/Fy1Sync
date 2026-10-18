/**
 * Streaming custom-protocol resources for the desktop client.
 *
 * The important parts are the path containment check and not
 * letting `index.html` be cached (a stale shell pointing at deleted hashed assets is the
 * classic "blank page after update" bug).
 */

import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join, normalize, resolve, sep } from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * `..` segments survive `decodeURIComponent`, so containment is checked on the resolved
 * absolute path rather than by pattern-matching the input.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null

  const rootDir = resolve(root)
  const candidate = resolve(join(rootDir, normalize(decoded)))
  if (candidate !== rootDir && !candidate.startsWith(rootDir + sep)) return null
  return candidate
}

export type StaticOptions = {
  root: string
  /** Served for any unmatched path so client-side routes like /admin work on reload. */
  spaFallback?: string
}

export type ByteRange = { start: number; end: number }

/**
 * Parse a single `Range: bytes=…` header against a known file size.
 *
 * Media seeking is built on this, which makes it load-bearing here rather than a nicety: a
 * `<video>` asked to jump to t=40 issues a range request, and a server that answers 200 with
 * the whole body makes the browser buffer from the start to get there. This tool rewinds a
 * stream by up to 60 s as its core operation, so that is the difference between a seek that
 * lands and one that crawls.
 *
 * `null` means "send the whole file" — the header was absent, malformed, or asked for
 * something this handler declines to split, all of which RFC 9110 permits a server to answer
 * in full. Multi-range requests take that path deliberately: they need a multipart body no
 * media element ever asks for. `'unsatisfiable'` is kept separate because a range that
 * starts past the end has to be a 416; answering it with a full body looks to the client
 * like the file silently changed size.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  const last = size - 1
  if (rawStart === '') {
    // `bytes=-N`: the final N bytes, which is how a player reads an MP4's trailing moov atom.
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    if (size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: last }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start)) return null
  if (start > last) return 'unsatisfiable'
  const end = rawEnd === '' ? last : Math.min(Number(rawEnd), last)
  if (!Number.isSafeInteger(end) || end < start) return null
  return { start, end }
}

export async function serveStatic(request: Request, options: StaticOptions): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const url = new URL(request.url)
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null
  const direct = resolveStaticPath(options.root, url.pathname)
  if (!direct) return null
  const hit = await statFile(direct)
  if (hit === 'file') return sendFile(request, direct, options.root)
  if (hit === 'dir') {
    const index = join(direct, 'index.html')
    if (await statFile(index) === 'file') return sendFile(request, index, options.root)
  }
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  if (last.includes('.') && !last.endsWith('.html')) return null
  // Reserved resource namespaces must never turn an unknown media ID into HTML.
  if (url.pathname.startsWith('/media/') || url.pathname.startsWith('/test-sources/')) return null
  const shell = resolveStaticPath(options.root, `/${options.spaFallback ?? 'index.html'}`)
  if (!shell || await statFile(shell) !== 'file') return null
  return sendFile(request, shell, options.root)
}

async function statFile(path: string): Promise<'file' | 'dir' | null> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  } catch { return null }
}

async function sendFile(request: Request, path: string, root: string): Promise<Response | null> {
  // Lexical containment alone cannot stop a symlink/junction out of the client tree.
  const [actual, actualRoot] = await Promise.all([realpath(path), realpath(root)])
  if (!actual.startsWith(actualRoot + sep)) return null
  const info = await stat(actual)
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
  const range = request.headers.has('if-range') ? null : parseRange(request.headers.get('range') ?? undefined, info.size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes', etag } })
  }
  const headers = {
    'content-type': contentTypeFor(actual),
    'content-length': String(range ? range.end - range.start + 1 : info.size),
    'accept-ranges': 'bytes', etag,
    'cache-control': /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(actual) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
  }
  if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status: range ? 206 : 200, headers })
  const stream = range ? createReadStream(actual, { start: range.start, end: range.end }) : createReadStream(actual)
  const abort = () => stream.destroy()
  request.signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => request.signal.removeEventListener('abort', abort))
  if (request.signal.aborted) stream.destroy()
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
}

export function missingClientResponse(clientDir: string): Response {
  return new Response(`前端尚未构建.\n期望目录: ${clientDir}\n请先运行: npm run build\n开发模式: npm run dev`, { status: 503 })
}
