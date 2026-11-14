import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'

const MAX_IMAGE_BYTES = 256 * 1024
const FILE = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/

/** Content-addressed local images keep the renderer CSP and avoid platform hotlinking. */
export class SavedRoomImages {
  constructor(private readonly root: string) {}

  async cache(url: string | null, read: (url: string) => Promise<Response>, signal: AbortSignal): Promise<string | null> {
    if (!url) return null
    const response = await read(url)
    if (!response.ok || !response.body) { await response.body?.cancel(); return null }
    const size = response.headers.get('content-length')
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_IMAGE_BYTES)) { await response.body.cancel(); return null }
    const reader = response.body.getReader()
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (!signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > MAX_IMAGE_BYTES || chunks.length >= 1024) return null
        chunks.push(next.value)
      }
    } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock() }
    if (signal.aborted) return null
    const bytes = Buffer.concat(chunks)
    const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
      : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) ? 'gif'
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp' : null
    if (!extension) return null
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
    const directory = privateDirectory(this.root, path.join(this.root, 'rooms', 'images'))
    const file = containedPath(this.root, path.join(directory, name))
    if (!fs.existsSync(file)) {
      const temporary = containedPath(this.root, path.join(directory, `.${randomUUID()}.tmp`))
      try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file) }
      finally { if (fs.existsSync(temporary)) fs.rmSync(temporary) }
    } else assertRegularPath(file, false)
    return `/room-image/${name}`
  }

  response(request: Request): Response {
    const name = new URL(request.url).pathname.slice('/room-image/'.length)
    if (request.method !== 'GET' || !FILE.test(name)) return new Response(null, { status: 404 })
    try {
      const file = containedPath(this.root, path.join(this.root, 'rooms', 'images', name))
      assertRegularPath(file, false)
      if (fs.statSync(file).size > MAX_IMAGE_BYTES) return new Response(null, { status: 404 })
      const type = name.endsWith('.jpg') ? 'jpeg' : name.split('.').at(-1)!
      return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'Content-Type': `image/${type}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' } })
    } catch { return new Response(null, { status: 404 }) }
  }

  prune(kept: Set<string>): void {
    const directory = containedPath(this.root, path.join(this.root, 'rooms', 'images'))
    if (!fs.existsSync(directory)) return
    for (const name of fs.readdirSync(directory)) {
      if (!FILE.test(name) || kept.has(`/room-image/${name}`)) continue
      const file = containedPath(this.root, path.join(directory, name))
      assertRegularPath(file, false)
      // Keep recent unreferenced files while concurrent collections may still commit them.
      if (fs.statSync(file).mtimeMs > Date.now() - 3_600_000) continue
      fs.rmSync(file)
    }
  }
}
