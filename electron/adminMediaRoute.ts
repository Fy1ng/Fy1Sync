import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const ASSET_ID = /^[a-zA-Z0-9_-]{1,128}$/
const MEDIA_FILE = /^media\.mp4$/
interface RegisteredAsset { file: string; directory: string; contentType: string }

/** Only the main-process importer can publish files behind this capability route. */
export class AdminMediaRoute {
  private readonly assets = new Map<string, RegisteredAsset>()
  private readonly root: string

  constructor(root: string) { this.root = path.resolve(root) }

  register(assetId: string, file: string): string {
    const directory = path.resolve(this.root, assetId)
    const candidate = path.resolve(file)
    if (!ASSET_ID.test(assetId) || path.dirname(directory) !== this.root
      || path.dirname(candidate) !== directory || !MEDIA_FILE.test(path.basename(candidate))) {
      throw new Error('invalid admin media registration')
    }
    this.assets.set(assetId, { directory, file: candidate,
      contentType: 'video/mp4' })
    return `app://app/admin-media/${assetId}`
  }

  unregister(assetId: string): void { this.assets.delete(assetId) }
  clear(): void { this.assets.clear() }

  async handle(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 403 }) }
    if (url.protocol !== 'app:' || url.hostname !== 'app' || url.port || url.username || url.password || url.search || url.hash) {
      return new Response(null, { status: 403 })
    }
    const match = /^\/admin-media\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname)
    const assetId = match?.[1]
    const asset = assetId ? this.assets.get(assetId) : undefined
    if (!asset || !assetId) return new Response(null, { status: 404 })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const [rootInfo, directoryInfo, fileInfo, actualRoot, actualDirectory, actualFile] = await Promise.all([
        lstat(this.root), lstat(asset.directory), lstat(asset.file),
        realpath(this.root), realpath(asset.directory), realpath(asset.file),
      ])
      // Require exact canonical locations, including the media root, to reject junctions and aliases.
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
        || !fileInfo.isFile() || fileInfo.isSymbolicLink() || path.relative(this.root, actualRoot) !== ''
        || path.relative(asset.directory, actualDirectory) !== '' || path.relative(asset.file, actualFile) !== '') {
        return new Response(null, { status: 403 })
      }
      if (this.assets.get(assetId) !== asset) return new Response(null, { status: 404 })
      handle = await open(asset.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.ino !== fileInfo.ino || info.dev !== fileInfo.dev || this.assets.get(assetId) !== asset) {
        await handle.close()
        return new Response(null, { status: 404 })
      }
      const headers = new Headers({
        'content-type': asset.contentType, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
      })
      const range = parseRange(request.headers.get('range'), info.size)
      if (range === false) {
        await handle.close()
        headers.set('content-range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? info.size - 1
      headers.set('content-length', String(Math.max(0, end - start + 1)))
      if (range) headers.set('content-range', `bytes ${start}-${end}/${info.size}`)
      const status = range ? 206 : 200
      if (request.method === 'HEAD' || info.size === 0 || request.signal.aborted) {
        await handle.close()
        return new Response(null, { status, headers })
      }
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
