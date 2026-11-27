import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { isStreamId, type StreamId } from './streamIdentity'

export type BufferRole = StreamId
interface ActiveRole {
  generation: string
  directory: string
  playlist?: Uint8Array<ArrayBuffer>
  segments: Map<string, Uint8Array<ArrayBuffer>>
  segmentBytes: number
  verified?: Promise<{ sessionRoot: string; directory: string } | null>
}
const TOKEN = /^[a-zA-Z0-9_-]{1,128}$/
const FILE = /^(?:index\.m3u8|segment_\d+_\d{9}\.(?:ts|m4s)|init_\d+\.mp4)$/
const MAX_CACHED_SEGMENT_BYTES = 16 * 1_048_576
const MAX_ROLE_SEGMENT_CACHE_BYTES = 32 * 1_048_576
const utf8Encoder = new TextEncoder()

/** A capability route for published files in the current session only. */
export class BufferRoute {
  private readonly roles = new Map<BufferRole, ActiveRole>()
  constructor(private readonly sessionId: string, private readonly sessionRoot: string) {
    if (!TOKEN.test(sessionId)) throw new Error('invalid buffer session')
  }
  activate(role: BufferRole, generation: string, directory: string): string {
    if (!isStreamId(role) || !TOKEN.test(generation) || path.resolve(directory) !== path.resolve(this.sessionRoot, role)) throw new Error('invalid buffer directory')
    this.roles.set(role, { generation, directory: path.resolve(directory), segments: new Map(), segmentBytes: 0 })
    return `app://app/buffer/${this.sessionId}/${role}/${generation}/index.m3u8`
  }
  setPlaylist(role: BufferRole, generation: string, content: string): void {
    const active = this.roles.get(role)
    if (!active || active.generation !== generation) return
    active.playlist = utf8Encoder.encode(content)
  }
  setSegment(role: BufferRole, generation: string, filename: string, bytes: Uint8Array<ArrayBuffer>): void {
    const active = this.roles.get(role)
    if (!active || active.generation !== generation || !FILE.test(filename) || filename === 'index.m3u8') return
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CACHED_SEGMENT_BYTES) return
    const previous = active.segments.get(filename)
    if (previous) {
      active.segmentBytes -= previous.byteLength
      active.segments.delete(filename)
    }
    active.segments.set(filename, bytes)
    active.segmentBytes += bytes.byteLength
    while (active.segmentBytes > MAX_ROLE_SEGMENT_CACHE_BYTES && active.segments.size > 1) {
      const oldest = active.segments.keys().next().value!
      // Keep init segments pinned ahead of older media chunks when evicting.
      let victim = oldest
      if (victim.startsWith('init_')) {
        const candidate = [...active.segments.keys()].find(name => !name.startsWith('init_'))
        if (candidate) victim = candidate
      }
      const removed = active.segments.get(victim)!
      active.segments.delete(victim)
      active.segmentBytes = Math.max(0, active.segmentBytes - removed.byteLength)
    }
  }
  evictSegment(role: BufferRole, generation: string, filename: string): void {
    const active = this.roles.get(role)
    if (!active || active.generation !== generation) return
    const existing = active.segments.get(filename)
    if (!existing) return
    active.segments.delete(filename)
    active.segmentBytes = Math.max(0, active.segmentBytes - existing.byteLength)
  }
  deactivate(role: BufferRole): void { this.roles.delete(role) }
  clear(): void { this.roles.clear() }

  private verifyBase(active: ActiveRole): Promise<{ sessionRoot: string; directory: string } | null> {
    active.verified ??= Promise.all([realpath(this.sessionRoot), realpath(active.directory), lstat(active.directory)])
      .then(([sessionRoot, directory, dirInfo]) => {
        if (dirInfo.isSymbolicLink() || path.relative(path.resolve(this.sessionRoot), sessionRoot) !== '' || !inside(sessionRoot, directory)) return null
        return { sessionRoot, directory }
      }).catch(() => { active.verified = undefined; return null })
    return active.verified
  }

  async handle(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 403 }) }
    if (url.protocol !== 'app:' || url.hostname !== 'app' || url.port || url.username || url.password || url.search || url.hash) return new Response(null, { status: 403 })
    const parts = url.pathname.split('/')
    if (parts.length !== 6 || parts[1] !== 'buffer' || parts[2] !== this.sessionId || !isStreamId(parts[3]) || !FILE.test(parts[5]!)) return new Response(null, { status: 404 })
    const role = parts[3] as BufferRole
    const active = this.roles.get(role)
    if (!active || parts[4] !== active.generation) return new Response(null, { status: 404 })
    const candidate = path.resolve(active.directory, parts[5]!)
    if (!inside(active.directory, candidate)) return new Response(null, { status: 403 })
    // Serve published playlists and hot sealed segments directly from memory after
    // directory verification to avoid Windows file-lock retries and AV scan stalls.
    const cachedBytes = parts[5] === 'index.m3u8' ? active.playlist : active.segments.get(parts[5]!)
    if (cachedBytes !== undefined) {
      const base = await this.verifyBase(active)
      if (!base) return new Response(null, { status: 403 })
      if (this.roles.get(role) !== active) return new Response(null, { status: 404 })
      const bytes = cachedBytes
      const headers = new Headers({
        'content-type': parts[5] === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : parts[5]!.endsWith('.ts') ? 'video/mp2t' : 'video/mp4',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
      })
      const range = parseRange(request.headers.get('range'), bytes.byteLength)
      if (range === false) { headers.set('content-range', `bytes */${bytes.byteLength}`); return new Response(null, { status: 416, headers }) }
      const start = range?.start ?? 0
      const end = range?.end ?? bytes.byteLength - 1
      headers.set('content-length', String(Math.max(0, end - start + 1)))
      if (range) headers.set('content-range', `bytes ${start}-${end}/${bytes.byteLength}`)
      const status = range ? 206 : 200
      if (request.method === 'HEAD' || bytes.byteLength === 0 || request.signal.aborted) return new Response(null, { status, headers })
      return new Response(bytes.subarray(start, end + 1), { status, headers })
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const [base, filename, fileInfo] = await Promise.all([
        this.verifyBase(active), realpath(candidate), lstat(candidate),
      ])
      if (!base || fileInfo.isSymbolicLink() || !inside(base.directory, filename)) return new Response(null, { status: 403 })
      if (this.roles.get(role) !== active) return new Response(null, { status: 404 })
      handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || this.roles.get(role) !== active) { await handle.close(); return new Response(null, { status: 404 }) }
      const headers = new Headers({
        'content-type': parts[5] === 'index.m3u8' ? 'application/vnd.apple.mpegurl' : parts[5]!.endsWith('.ts') ? 'video/mp2t' : 'video/mp4',
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
