import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

export type BufferRole = 'official' | 'commentary'
interface ActiveRole { generation: string; directory: string }
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/
const FILE = /^(?:index\.m3u8|segment_\d+_\d{9}\.ts)$/

/** A capability route for published files in the current session only. */
export class BufferRoute {
  private readonly roles = new Map<BufferRole, ActiveRole>()
  constructor(private readonly sessionId: string, private readonly sessionRoot: string) {
    if (!TOKEN.test(sessionId)) throw new Error('invalid buffer session')
  }
  activate(role: BufferRole, generation: string, directory: string): string {
    if (!TOKEN.test(generation) || path.resolve(directory) !== path.resolve(this.sessionRoot, role)) throw new Error('invalid buffer directory')
    this.roles.set(role, { generation, directory: path.resolve(directory) })
    return `app://app/buffer/${this.sessionId}/${role}/${generation}/index.m3u8`
  }
  deactivate(role: BufferRole): void { this.roles.delete(role) }
  clear(): void { this.roles.clear() }

  async handle(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 403 }) }
    if (url.protocol !== 'app:' || url.hostname !== 'app' || url.port || url.username || url.password || url.search || url.hash) return new Response(null, { status: 403 })
    const parts = url.pathname.split('/')
    if (parts.length !== 6 || parts[1] !== 'buffer' || parts[2] !== this.sessionId || !['official', 'commentary'].includes(parts[3]!) || !FILE.test(parts[5]!)) return new Response(null, { status: 404 })
    const role = parts[3] as BufferRole
    const active = this.roles.get(role)
    if (!active || parts[4] !== active.generation) return new Response(null, { status: 404 })
    const candidate = path.resolve(active.directory, parts[5]!)
    if (!inside(active.directory, candidate)) return new Response(null, { status: 403 })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const [sessionRoot, directory, filename, fileInfo, dirInfo] = await Promise.all([
        realpath(this.sessionRoot), realpath(active.directory), realpath(candidate), lstat(candidate), lstat(active.directory),
      ])
      if (fileInfo.isSymbolicLink() || dirInfo.isSymbolicLink() || path.relative(path.resolve(this.sessionRoot), sessionRoot) !== '' || !inside(sessionRoot, directory) || !inside(directory, filename)) return new Response(null, { status: 403 })
      if (this.roles.get(role) !== active) return new Response(null, { status: 404 })
      handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || this.roles.get(role) !== active) { await handle.close(); return new Response(null, { status: 404 }) }
      const headers = new Headers({
        'content-type': parts[5] === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
      })
      const range = parseRange(request.headers.get('range'), info.size)
      if (range === false) { await handle.close(); headers.set('content-range', `bytes */${info.size}`); return new Response(null, { status: 416, headers }) }
      const start = range?.start ?? 0
      const end = range?.end ?? info.size - 1
      headers.set('content-length', String(Math.max(0, end - start + 1)))
      if (range) headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
      const status = range ? 206 : 200
      if (request.method === 'HEAD' || info.size === 0 || request.signal.aborted) { await handle.close(); return new Response(null, { status, headers }) }
      const stream = handle.createReadStream({ start, end, autoClose: true })
      const abort = () => stream.destroy()
      request.signal.addEventListener('abort', abort, { once: true })
      stream.once('close', () => request.signal.removeEventListener('abort', abort))
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array<ArrayBuffer>>, { status, headers })
    } catch {
      await handle?.close().catch(() => {})
      return new Response(null, { status: 404 })
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function parseRange(value: string | null, length: number): { start: number; end: number } | false | null {
  if (value === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2]) || length === 0) return false
  if (!match[1]) {
    const suffix = Number(match[2])
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, length - suffix), end: length - 1 } : false
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : length - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end) return false
  return { start, end: Math.min(end, length - 1) }
}
