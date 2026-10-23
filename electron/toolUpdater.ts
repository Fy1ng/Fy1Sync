import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toolVersion } from './toolVersions'
import { containedPath } from './privateStorage'

const API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_EXE = 64 * 1_048_576
const MAX_JSON = 1_048_576
const MAX_SUMS = 128 * 1024
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
type Entry = { id: string; version: string; sha256: string }
type Manifest = { schema: 1; active?: Entry; previous?: Entry }
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'current' | 'restored' | 'error'
export interface ToolUpdateState { phase: UpdatePhase; downloadedBytes: number; totalBytes: number; downloadedVersion?: string; activeVersion?: string; previousVersion?: string; message: string }
export interface ToolUpdaterService {
  state(): ToolUpdateState
  update(): Promise<ToolUpdateState>
  restore(target: 'previous' | 'bundled'): Promise<ToolUpdateState>
}
type Transport = (url: string, init: RequestInit) => Promise<Response>

export class UpdateError extends Error {
  constructor(readonly code: 'network' | 'limit' | 'release' | 'checksum' | 'verification' | 'storage' | 'busy') { super(code) }
}
const messages: Record<UpdateError['code'], string> = {
  network: '更新下载失败, 请检查网络后重试. 原版本仍可使用.',
  limit: '更新内容超过安全限制, 已取消. 原版本仍可使用.',
  release: '官方稳定版信息不符合预期, 已取消. 原版本仍可使用.',
  checksum: '下载文件的 SHA256 校验失败, 未启用该版本.',
  verification: '下载工具的版本验证失败, 未启用该版本.',
  storage: '更新无法安全保存, 原版本仍可使用.',
  busy: '更新正在进行, 请等待完成.',
}
function entry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Entry
  return Object.keys(v).sort().join(',') === 'id,sha256,version' && typeof v.id === 'string' && ID.test(v.id)
    && typeof v.version === 'string' && VERSION.test(v.version) && typeof v.sha256 === 'string' && HASH.test(v.sha256)
}
export function parseManagedManifest(text: string): Manifest {
  if (Buffer.byteLength(text) > 4096) throw new UpdateError('storage')
  const v: unknown = JSON.parse(text)
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UpdateError('storage')
  const m = v as Manifest
  if (m.schema !== 1 || Object.keys(m).some(k => !['schema', 'active', 'previous'].includes(k))
    || (m.active !== undefined && !entry(m.active)) || (m.previous !== undefined && !entry(m.previous))) throw new UpdateError('storage')
  return m
}
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  let length = 0
  for await (const bytes of createReadStream(file)) {
    length += bytes.length
    if (length > MAX_EXE) throw new UpdateError('limit')
    hash.update(bytes)
  }
  return hash.digest('hex')
}
/** All URLs are constructed in main. The injected transport is a test seam, never an IPC input. */
export async function officialDownload(url: string, limit: number, consume: (bytes: Buffer) => Promise<void>, transport: Transport = fetch): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    let current = url
    for (let redirects = 0; redirects <= 4; redirects++) {
      const parsed = new URL(current)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash || !hosts.has(parsed.hostname)) throw new UpdateError('network')
      const response = await transport(current, { redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'Stream-Syncer-Manual-Updater', 'Accept-Encoding': 'identity', Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 4) throw new UpdateError('network')
        current = new URL(location, current).href
        continue
      }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new UpdateError('network') }
      if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body.cancel(); throw new UpdateError('network') }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body.cancel(); throw new UpdateError('limit') }
      const reader = response.body.getReader()
      let count = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (controller.signal.aborted) throw new UpdateError('network')
          if (next.done) break
          count += next.value.byteLength
          if (count > limit) throw new UpdateError('limit')
          await consume(Buffer.from(next.value))
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (!count || (length !== null && count !== Number(length))) throw new UpdateError('network')
      return
    }
    throw new UpdateError('network')
  } catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError('network') }
  finally { clearTimeout(timer) }
}
async function downloadBytes(url: string, limit: number, transport?: Transport): Promise<Buffer> {
  const chunks: Buffer[] = []
  await officialDownload(url, limit, async bytes => { chunks.push(bytes) }, transport)
  return Buffer.concat(chunks)
}
function release(value: unknown): { version: string; exe: string; sums: string; size: number } {
  if (!value || typeof value !== 'object') throw new UpdateError('release')
  const r = value as Record<string, unknown>
  if (typeof r.tag_name !== 'string' || !VERSION.test(r.tag_name) || r.draft !== false || r.prerelease !== false || !Array.isArray(r.assets) || r.assets.length > 100) throw new UpdateError('release')
  const assets = r.assets
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${r.tag_name}/`
  const asset = (name: string, limit: number) => {
    const found = assets.filter((a: unknown) => a && typeof a === 'object' && (a as Record<string, unknown>).name === name) as Record<string, unknown>[]
    const a = found[0]
    if (found.length !== 1 || !a || a.browser_download_url !== base + name || !Number.isSafeInteger(a.size) || (a.size as number) <= 0 || (a.size as number) > limit) throw new UpdateError('release')
    return { url: base + name, size: a.size as number }
  }
  const exe = asset('yt-dlp.exe', MAX_EXE), sums = asset('SHA2-256SUMS', MAX_SUMS)
  return { version: r.tag_name, exe: exe.url, sums: sums.url, size: exe.size }
}
export function releaseChecksum(text: string): string {
  const matches = text.split(/\r?\n/).filter(line => /(?:\s|\*)yt-dlp\.exe(?:\s|$)/.test(line))
  if (matches.length !== 1) throw new UpdateError('checksum')
  const match = /^([a-fA-F0-9]{64}) [ *]yt-dlp\.exe$/.exec(matches[0]!)
  if (!match) throw new UpdateError('checksum')
  return match[1]!.toLowerCase()
}

export class ManagedYtdlp implements ToolUpdaterService {
  private readonly root: string
  private readonly userData: string
  private manifest: Manifest = { schema: 1 }
  private initialized?: Promise<void>
  private flight?: Promise<ToolUpdateState>
  private status: ToolUpdateState = { phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: '仅手动检查官方稳定版, 启动时不联网.' }
  constructor(userData: string, private readonly options: { transport?: Transport; verify?: (file: string) => Promise<string>; baselineVersion?: string } = {}) {
    this.userData = path.resolve(userData)
    this.root = path.join(userData, 'managed-tools', 'yt-dlp')
  }
  state(): ToolUpdateState { return { ...this.status, activeVersion: this.manifest.active?.version, previousVersion: this.manifest.previous?.version } }
  private async safeRoot(create = false): Promise<void> {
    containedPath(this.userData, this.root)
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    const actual = await realpath(this.root)
    if (path.resolve(actual).toLowerCase() !== path.resolve(this.root).toLowerCase() || (await lstat(this.root)).isSymbolicLink()) throw new UpdateError('storage')
  }
  private async valid(e?: Entry): Promise<string | undefined> {
    if (!e) return undefined
    try {
      await this.safeRoot()
      const dir = path.join(this.root, e.id), file = path.join(dir, 'yt-dlp.exe')
      if ((await lstat(dir)).isSymbolicLink() || (await lstat(file)).isSymbolicLink() || await realpath(file) !== file) return undefined
      const s = await stat(file)
      if (!s.isFile() || s.size <= 0 || s.size > MAX_EXE || await sha256File(file) !== e.sha256) return undefined
      return file
    } catch { return undefined }
  }
  private init(): Promise<void> {
    return this.initialized ??= (async () => {
      try {
        await this.safeRoot()
        const file = path.join(this.root, 'active.json')
        if ((await lstat(file)).isSymbolicLink() || (await stat(file)).size > 4096) throw new UpdateError('storage')
        const handle = await open(file, 'r')
        let text: string
        try {
          const bytes = Buffer.alloc(4097)
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
          if (bytesRead > 4096) throw new UpdateError('storage')
          text = bytes.subarray(0, bytesRead).toString('utf8')
        } finally { await handle.close() }
        const m = parseManagedManifest(text)
        const active = await this.valid(m.active), previous = await this.valid(m.previous)
        this.manifest = { schema: 1, ...(active ? { active: m.active } : m.active && previous ? { active: m.previous } : {}), ...((active || !m.active) && previous && m.active?.id !== m.previous?.id ? { previous: m.previous } : {}) }
        if (m.active && !active) this.status.message = previous ? '已拒绝损坏的更新, 回退到上一版本.' : '已拒绝损坏的更新, 使用内置工具.'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.status.message = '更新记录无效, 使用内置工具.'
      }
    })()
  }
  async activePath(): Promise<string | undefined> {
    await this.init()
    if (await this.valid(this.manifest.active)) return path.join(this.root, this.manifest.active!.id, 'yt-dlp.exe')
    if (this.manifest.active) {
      const fallback = await this.valid(this.manifest.previous)
      this.manifest = { schema: 1, ...(fallback ? { active: this.manifest.previous } : {}) }
      this.status.message = fallback ? '更新文件损坏, 已回退上一版本.' : '更新文件损坏, 已回退内置工具.'
      return fallback
    }
    return undefined
  }
  private async save(m: Manifest): Promise<void> {
    await this.safeRoot(true)
    const temporary = path.join(this.root, `manifest-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(m) + '\n', { flag: 'wx', mode: 0o600 })
      await rename(temporary, path.join(this.root, 'active.json'))
      this.manifest = m
    } finally { await rm(temporary, { force: true }) }
  }
  update(): Promise<ToolUpdateState> {
    if (this.flight) return this.flight
    this.flight = this.performUpdate().finally(() => { this.flight = undefined })
    return this.flight
  }
  private async performUpdate(): Promise<ToolUpdateState> {
    let temporary: string | undefined, promoted: string | undefined, committed = false
    try {
      await this.init()
      await this.activePath()
      this.status = { phase: 'checking', downloadedBytes: 0, totalBytes: 0, message: '正在检查 GitHub 官方稳定版...' }
      let info: ReturnType<typeof release>
      try { info = release(JSON.parse((await downloadBytes(API, MAX_JSON, this.options.transport)).toString('utf8'))) }
      catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError('release') }
      const current = this.manifest.active?.version ?? this.options.baselineVersion
      if (current && info.version.localeCompare(current, 'en', { numeric: true }) <= 0) {
        this.status = { ...this.status, phase: 'current', message: '当前受控工具已是该稳定版或更新版本.' }
        return this.state()
      }
      const checksum = releaseChecksum((await downloadBytes(info.sums, MAX_SUMS, this.options.transport)).toString('utf8'))
      await this.safeRoot(true)
      temporary = path.join(this.root, `download-${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o700)
      const hash = createHash('sha256')
      this.status = { phase: 'downloading', downloadedBytes: 0, totalBytes: info.size, downloadedVersion: info.version, message: '正在下载并计算 SHA256...' }
      try {
        await officialDownload(info.exe, info.size, async bytes => {
          // FileHandle.write can be partial; writeFile with an open handle writes the complete chunk.
          await file.writeFile(bytes)
          hash.update(bytes)
          this.status.downloadedBytes += bytes.length
        }, this.options.transport)
        await file.sync()
      } finally { await file.close() }
      if (this.status.downloadedBytes !== info.size || hash.digest('hex') !== checksum) throw new UpdateError('checksum')
      this.status = { ...this.status, phase: 'verifying', message: 'SHA256 已通过, 正在验证工具版本...' }
      // Windows needs the native executable extension for CreateProcess.
      // Short opaque directory names also avoid Windows CreateProcess MAX_PATH failures.
      const id = randomUUID()
      promoted = path.join(this.root, id)
      await mkdir(promoted, { mode: 0o700 })
      const executable = path.join(promoted, 'yt-dlp.exe')
      await rename(temporary, executable)
      temporary = undefined
      let verified: string
      try { verified = await (this.options.verify ?? (file => toolVersion(file, true)))(executable) } catch { throw new UpdateError('verification') }
      if (verified !== info.version) throw new UpdateError('verification')
      if (await sha256File(executable) !== checksum) throw new UpdateError('checksum')
      const previous = this.manifest.active ?? this.manifest.previous
      await this.save({ schema: 1, active: { id, version: info.version, sha256: checksum }, ...(previous ? { previous } : {}) })
      committed = true
      this.status = { ...this.status, phase: 'ready', message: `已验证 ${info.version}, 下次取流使用. 当前播放继续.` }
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : 'storage'
      this.status = { ...this.status, phase: 'error', message: messages[code] }
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {})
      if (promoted && !committed) await rm(promoted, { recursive: true, force: true }).catch(() => {})
    }
    return this.state()
  }
  async restore(target: 'previous' | 'bundled'): Promise<ToolUpdateState> {
    if (this.flight) return { ...this.state(), message: messages.busy }
    const operation = (async () => {
      try {
        await this.init()
        if (target === 'previous') {
          if (!await this.valid(this.manifest.previous)) throw new UpdateError('verification')
          await this.save({ schema: 1, active: this.manifest.previous, ...(this.manifest.active ? { previous: this.manifest.active } : {}) })
        } else await this.save({ schema: 1, ...(this.manifest.active ? { previous: this.manifest.active } : {}) })
        this.status = { phase: 'restored', downloadedBytes: 0, totalBytes: 0, message: '已恢复选择, 下次取流使用. 当前播放继续.' }
      } catch { this.status = { ...this.status, phase: 'error', message: messages.storage } }
      return this.state()
    })()
    this.flight = operation.finally(() => { this.flight = undefined })
    return this.flight
  }
}
