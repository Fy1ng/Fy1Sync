import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { parseHudStylePack } from '../src/core/hudStylePack'
import { trustedSender } from './ipc'
import { isAdminDocument } from './ytImportIpc'
import type { EditorLocalMedia, EditorMediaLocation, EditorProject, EditorProjectLoaded } from './editorProjectContracts'

const ID = /^[a-zA-Z0-9_-]{1,128}$/
const SHA256 = /^[a-f0-9]{64}$/
const PROJECT_LIMIT = 32 * 1024 * 1024
const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' }
const invalid = () => Object.assign(new Error('工程参数无效.'), { code: 'invalid-arguments' })
const missing = () => Object.assign(new Error('素材文件不可用, 请重新选择该文件.'), { code: 'media-unavailable' })

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)
    && descriptors[key] && 'value' in descriptors[key]!) && required.every(key => Object.hasOwn(descriptors, key))
}

function projectValue(value: unknown): EditorProject {
  if (!fields(value, ['version', 'pack', 'variantId', 'media', 'currentMediaId']) || value.version !== 1
    || typeof value.variantId !== 'string' || !Array.isArray(value.media) || value.media.length > 1000
    || (value.currentMediaId !== null && typeof value.currentMediaId !== 'string')) throw invalid()
  if (!fields(value.pack, ['kind', 'schemaVersion', 'id', 'revision', 'name', 'bitmaps', 'variants'])
    || typeof value.pack.id !== 'string' || typeof value.pack.name !== 'string') throw invalid()
  // Draft identity fields may be incomplete while typing; portable exports stay strict.
  const parsed = parseHudStylePack({ ...value.pack, id: 'draft/untitled', name: '草稿' })
  if (!parsed.pack || !parsed.pack.variants.some(variant => variant.id === value.variantId)) throw invalid()
  const ids = new Set<string>()
  for (const raw of value.media as unknown[]) {
    const common = ['id', 'name', 'match', 'purpose', 'kind']
    if (!fields(raw, common, ['path', 'size', 'sha256', 'assetId'])) throw invalid()
    const media = raw
    if (!fields(media, [...common, ...(media.kind === 'local' ? ['path', 'size', 'sha256'] : ['assetId'])])
      || typeof media.id !== 'string' || !ID.test(media.id) || ids.has(media.id)
      || typeof media.name !== 'string' || media.name.length > 4096 || typeof media.match !== 'string' || media.match.length > 4096
      || !['making', 'validation'].includes(media.purpose as string)) throw invalid()
    ids.add(media.id)
    if (media.kind === 'local') {
      if (typeof media.path !== 'string' || media.path.length > 32768 || !path.isAbsolute(media.path)
        || typeof media.size !== 'number' || !Number.isSafeInteger(media.size) || media.size < 1
        || typeof media.sha256 !== 'string' || !SHA256.test(media.sha256)) throw invalid()
    } else if (media.kind !== 'youtube' || typeof media.assetId !== 'string' || !ID.test(media.assetId)) throw invalid()
  }
  if (value.currentMediaId !== null && !ids.has(value.currentMediaId)) throw invalid()
  return value as unknown as EditorProject
}

async function regularFile(file: string) {
  const [info, actual] = await Promise.all([lstat(file), realpath(file)])
  // Canonical equality rejects file symlinks as well as junctions in parent directories.
  if (!info.isFile() || info.isSymbolicLink() || path.relative(file, actual) !== '') throw missing()
  return info
}

/**
 * One current project; local file grants originate only from the native picker or its saved manifest.
 * The file holds a draft pack, media paths and match notes, no credentials, so it is written like
 * the preset files with asynchronous writes, since the editor saves on every edit.
 */
export class EditorProjectManager {
  private readonly file: string
  private writing: Promise<void> = Promise.resolve()
  private initialized = false
  private initializing: Promise<void> | null = null
  private project: EditorProject | null = null
  private readonly local = new Map<string, EditorLocalMedia>()
  private readonly mediaRoutes = new Map<string, string>()
  private readonly routes = new Map<string, { file: string; size: number; sha256: string; contentType: string }>()

  constructor(private readonly options: {
    userDataDirectory: string
    chooseFile: () => Promise<string | null>
    beforeLoad?: () => Promise<void>
  }) {
    this.file = path.join(path.resolve(options.userDataDirectory), 'editor', 'current-project.json')
  }

  async load(): Promise<EditorProjectLoaded> {
    await this.initialize()
    await this.writing
    const project = this.project ? structuredClone(this.project) : null
    const restored = project?.currentMediaId ? await this.restore(project.currentMediaId) : { media: null, needsRelink: false }
    return { project, ...restored }
  }

  private initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    // StrictMode, diagnostics and autosave observers can read concurrently. Hydrate once;
    // reading a snapshot must not revoke URLs held by a player or a validation decoder.
    this.initializing ??= this.readInitialProject().then(() => { this.initialized = true }, error => {
      this.initializing = null
      throw error
    })
    return this.initializing
  }

  private async readInitialProject(): Promise<void> {
    await this.options.beforeLoad?.()
    let value: unknown
    try {
      const info = await lstat(this.file)
      if (!info.isFile() || info.size > PROJECT_LIMIT) throw new Error()
      value = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('工程读取失败, 原文件已保留.')
    }
    this.project = value === undefined ? null : projectValue(value)
    for (const media of this.project?.media ?? []) if (media.kind === 'local') this.local.set(media.id, structuredClone(media))
  }

  async save(value: unknown): Promise<{ ok: true }> {
    const project = structuredClone(projectValue(value))
    await this.initialize()
    for (const media of project.media) if (media.kind === 'local') {
      const granted = this.local.get(media.id)
      if (!granted || media.path !== granted.path || media.size !== granted.size || media.sha256 !== granted.sha256) throw invalid()
    }
    const text = JSON.stringify(project)
    if (Buffer.byteLength(text, 'utf8') > PROJECT_LIMIT) throw invalid()
    // Writes run in order, so an older snapshot never lands after a newer one.
    const write = this.writing.then(async () => {
      await this.write(text)
      this.project = project
      for (const media of project.media) if (media.kind === 'local') this.local.set(media.id, structuredClone(media))
    })
    this.writing = write.catch(() => {})
    await write
    return { ok: true }
  }

  async choose(relinkId?: string): Promise<{ media: EditorLocalMedia; url: string } | null> {
    await this.initialize()
    const expected = relinkId === undefined ? undefined : this.local.get(relinkId)
    if (relinkId !== undefined && !expected) throw invalid()
    const selected = await this.options.chooseFile()
    if (selected === null) return null
    const file = path.resolve(selected)
    if (!Object.hasOwn(TYPES, path.extname(file).toLowerCase())) throw missing()
    const before = await regularFile(file)
    if (before.size < 1 || (expected && before.size !== expected.size)) throw this.mismatch()
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let sha256: string
    try {
      const opened = await handle.stat()
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw missing()
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      const after = await handle.stat()
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw missing()
      sha256 = hash.digest('hex')
    } finally { await handle.close() }
    if (expected && sha256 !== expected.sha256) throw this.mismatch()
    const media: EditorLocalMedia = expected ? { ...expected, path: file } : {
      id: randomUUID(), kind: 'local', path: file, name: path.basename(file), size: before.size, sha256, match: '', purpose: 'making',
    }
    this.local.set(media.id, media)
    if (this.project) this.project.media = this.project.media.map(item => item.id === media.id ? media : item)
    return { media: structuredClone(media), url: this.publish(media) }
  }

  async restore(id: string): Promise<{ media: EditorMediaLocation | null; needsRelink: boolean }> {
    await this.initialize()
    const media = this.local.get(id)
    if (!media) {
      if (this.project?.media.some(item => item.id === id && item.kind === 'youtube')) return { media: null, needsRelink: false }
      throw invalid()
    }
    try {
      const info = await regularFile(media.path)
      if (info.size !== media.size) throw missing()
      return { media: { id, url: this.publish(media) }, needsRelink: false }
    } catch { return { media: null, needsRelink: true } }
  }

  private async write(text: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }) }
  }

  private mismatch(): Error { return Object.assign(new Error('所选文件与原素材的大小或 SHA-256 不一致, 请重新选择原文件.'), { code: 'media-mismatch' }) }

  private publish(media: EditorLocalMedia): string {
    const previous = this.mediaRoutes.get(media.id)
    const asset = previous ? this.routes.get(previous) : undefined
    if (asset && asset.file === media.path && asset.size === media.size && asset.sha256 === media.sha256) {
      return `app://app/editor-media/${previous}`
    }
    // Relinking changes the grant's file identity; old paths must not become readable again.
    if (previous) this.routes.delete(previous)
    const token = randomUUID()
    this.routes.set(token, { file: media.path, size: media.size, sha256: media.sha256,
      contentType: TYPES[path.extname(media.path).toLowerCase()] ?? 'application/octet-stream' })
    this.mediaRoutes.set(media.id, token)
    return `app://app/editor-media/${token}`
  }

  /** Read-only streaming avoids buffering large videos and supports Chromium's seeking requests. */
  async handle(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 403 }) }
    if (url.protocol !== 'app:' || url.hostname !== 'app' || url.port || url.username || url.password || url.search || url.hash) return new Response(null, { status: 403 })
    const referrer = request.headers.get('referer')
    if (referrer && !isAdminDocument(referrer)) return new Response(null, { status: 403 })
    const token = /^\/editor-media\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname)?.[1]
    const asset = token ? this.routes.get(token) : undefined
    if (!asset) return new Response(null, { status: 404 })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const before = await regularFile(asset.file)
      handle = await open(asset.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== asset.size) throw missing()
      const headers = new Headers({ 'content-type': asset.contentType, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' })
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
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : length - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end) return false
  return { start, end: Math.min(end, length - 1) }
}

export function installEditorProjectIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, owner: WebContents, manager: EditorProjectManager) {
  let disposed = false
  let generation = 0
  const navigated = () => { generation++ }
  owner.on('did-start-navigation', navigated)
  const allowed = (event: IpcMainInvokeEvent) => !disposed && trustedSender(event, owner) && isAdminDocument(owner.mainFrame.url)
  const denied = () => ({ ok: false as const, code: 'forbidden', message: '仅允许当前编辑器窗口调用.' })
  ipc.handle('stream-syncer:editor-invoke', async (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    if (!allowed(event)) return denied()
    const revision = generation
    try {
      let value: unknown
      switch (method) {
        case 'editorProjectLoad':
          if (args !== undefined) throw invalid()
          value = await manager.load()
          break
        case 'editorProjectSave':
          if (!fields(args, ['project'])) throw invalid()
          value = await manager.save(args.project)
          break
        case 'editorMediaChoose':
          if (!fields(args, [], ['relinkId']) || (args.relinkId !== undefined && (typeof args.relinkId !== 'string' || !ID.test(args.relinkId)))) throw invalid()
          value = await manager.choose(args.relinkId as string | undefined)
          break
        case 'editorMediaRestore':
          if (!fields(args, ['id']) || typeof args.id !== 'string' || !ID.test(args.id)) throw invalid()
          value = await manager.restore(args.id)
          break
        default: return { ok: false, code: 'unknown-method', message: '未知工程接口.' }
      }
      return allowed(event) && revision === generation ? { ok: true, value } : denied()
    } catch (error) {
      if (!allowed(event) || revision !== generation) return denied()
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const messages: Record<string, string> = { 'invalid-arguments': '工程参数无效.',
        'media-unavailable': '素材文件不可用, 请重新选择该文件.', 'media-mismatch': '所选文件与原素材的大小或 SHA-256 不一致, 请重新选择原文件.' }
      return { ok: false, code: typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'project-failed',
        message: typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : '工程读取或保存失败, 原文件已保留.' }
    }
  })
  return { dispose() { disposed = true; generation++; owner.removeListener('did-start-navigation', navigated); ipc.removeHandler('stream-syncer:editor-invoke') } }
}
