/**
 * Static file serving for the built client, with SPA fallback.
 *
 * Deliberately small: this server exists to host one built bundle on loopback, not to be
 * a general web server. The important parts are the path containment check and not
 * letting `index.html` be cached (a stale shell pointing at deleted hashed assets is the
 * classic "blank page after update" bug).
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, normalize, resolve, sep } from 'node:path'
import { requestUrl, sendText } from './http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticOptions,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false

  const url = requestUrl(req)
  const fallback = options.spaFallback ?? 'index.html'

  const direct = resolveStaticPath(options.root, url.pathname)
  if (direct) {
    const hit = await statFile(direct)
    if (hit === 'file') return sendFile(req, res, direct, false)
    if (hit === 'dir') {
      const index = join(direct, 'index.html')
      if ((await statFile(index)) === 'file') return sendFile(req, res, index, true)
    }
  }

  // Unknown path: hand the SPA shell over so the client router can take it. An asset
  // request that misses must 404 instead, or a bad import silently receives HTML.
  if (looksLikeAsset(url.pathname)) return false

  const shell = resolveStaticPath(options.root, `/${fallback}`)
  if (!shell || (await statFile(shell)) !== 'file') return false
  return sendFile(req, res, shell, true)
}

function looksLikeAsset(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  return last.includes('.') && !last.endsWith('.html')
}

async function statFile(path: string): Promise<'file' | 'dir' | null> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'dir'
    return info.isFile() ? 'file' : null
  } catch {
    return null
  }
}

async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  isShell: boolean,
): Promise<boolean> {
  const info = await stat(path)
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag })
    res.end()
    return true
  }

  // Only ranges the client can trust: the etag above is weak, so it cannot prove the file is
  // byte-for-byte the one the client already holds. RFC 9110 says to ignore the range when the
  // validator in `If-Range` is weak, which costs a re-download and never stitches two
  // different versions of a file together.
  const range = req.headers['if-range'] ? null : parseRange(req.headers.range, info.size)

  if (range === 'unsatisfiable') {
    res.writeHead(416, {
      'content-range': `bytes */${info.size}`,
      'accept-ranges': 'bytes',
      etag,
    })
    res.end()
    return true
  }

  res.writeHead(range ? 206 : 200, {
    'content-type': contentTypeFor(path),
    'content-length': range ? range.end - range.start + 1 : info.size,
    // Advertised on every response, the 200 included: a player only learns it may seek from
    // the first response, before it has any range to ask about.
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
    etag,
    // Vite emits content-hashed asset names, so those are safe to cache hard. The
    // HTML shell must never be, or an update leaves the browser asking for gone files.
    'cache-control': isShell
      ? 'no-cache'
      : /-[A-Za-z0-9_]{8,}\.[a-z0-9]+$/.test(path)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
  })

  if ((req.method ?? 'GET') === 'HEAD') {
    res.end()
    return true
  }

  await new Promise<void>((resolvePromise) => {
    const stream = range
      ? createReadStream(path, { start: range.start, end: range.end })
      : createReadStream(path)
    stream.on('error', () => {
      res.destroy()
      resolvePromise()
    })
    stream.on('end', resolvePromise)
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })
  return true
}

export function sendMissingClient(res: ServerResponse, clientDir: string): void {
  sendText(
    res,
    503,
    [
      '前端尚未构建。',
      '',
      `期望目录：${clientDir}`,
      '',
      '请先运行：npm run build',
      '开发模式请改用：npm run dev',
    ].join('\n'),
  )
}
