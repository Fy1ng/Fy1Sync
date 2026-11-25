import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toolVersion } from './toolVersions'
import { containedPath } from './privateStorage'
import { ytdlpReleaseAsset, type YtdlpReleaseAsset } from './toolPlatform'
import { diagnosticDetails } from '../server/errorDetails'
import { httpErrorDetails } from '../server/httpError'
import { networkContext, type NetworkContext } from '../server/networkPolicy'
import { safeFetch, type Resolver } from '../server/safeFetch'
import type { ErrorDetails } from '../src/core/errorDetails'

const API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const VERSION = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/
const HASH = /^[a-f0-9]{64}$/
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_EXE = 64 * 1_048_576
const MAX_JSON = 1_048_576
const MAX_SUMS = 128 * 1024
const IDLE_TIMEOUT_MS = 60_000
const TOTAL_TIMEOUT_MS = 10 * 60_000
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
type Entry = { id: string; version: string; sha256: string }
type Manifest = { schema: 1; active?: Entry; previous?: Entry }
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'current' | 'restored' | 'cancelled' | 'error'
export interface ToolUpdateState { phase: UpdatePhase; downloadedBytes: number; totalBytes: number; bytesPerSecond?: number; downloadedVersion?: string; activeVersion?: string; previousVersion?: string; message: string; errorDetail?: ErrorDetails }
export interface ToolUpdaterService {
  state(): ToolUpdateState
  update(): Promise<ToolUpdateState>
  cancel(): Promise<ToolUpdateState>
  restore(target: 'previous' | 'bundled'): Promise<ToolUpdateState>
}
type Transport = (url: string, init: RequestInit) => Promise<Response>

export class UpdateError extends Error {
  constructor(readonly code: 'network' | 'limit' | 'release' | 'checksum' | 'verification' | 'storage' | 'busy' | 'cancelled', options?: ErrorOptions) { super(code, options) }
}
const messages: Record<UpdateError['code'], string> = {
  network: '下载失败，请检查网络后重试。已保留原版本。',
  limit: '更新内容超过限制，已取消并保留原版本',
  release: '无法确认官方版本信息，已保留原版本',
  checksum: '下载文件校验失败，未使用该更新',
  verification: '下载工具的版本验证失败，未启用该版本',
  storage: '更新保存失败，已保留原版本',
  busy: '更新正在进行，请等待完成',
  cancelled: '已取消更新，已保留原版本',
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
/** Route official tool updates through the configured system proxy and SSRF policy. */
export function createOfficialToolTransport(options: { network?: () => NetworkContext; fetchImpl?: typeof fetch; resolve?: Resolver } = {}): Transport {
  return async (url, init) => {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash || !hosts.has(parsed.hostname)) {
      throw new UpdateError('network')
    }
    const { response } = await safeFetch(url, {
      enabled: true, hosts: [parsed.hostname], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: IDLE_TIMEOUT_MS,
    }, {
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string> | undefined,
      signal: init.signal ?? undefined,
      manualRedirect: true,
      network: options.network?.() ?? networkContext(),
      fetchImpl: options.fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit)),
      resolve: options.resolve,
    })
    return response
  }
}

/** All URLs are constructed in main. The injected transport is a test seam, never an IPC input. */
export async function officialDownload(url: string, limit: number, consume: (bytes: Buffer) => Promise<void>, transport: Transport = createOfficialToolTransport(), externalSignal?: AbortSignal): Promise<void> {
  if (externalSignal?.aborted) throw new UpdateError('cancelled')
  const controller = new AbortController()
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  }
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  resetIdle()
  try {
    let current = url
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (externalSignal?.aborted) throw new UpdateError('cancelled')
      const parsed = new URL(current)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash || !hosts.has(parsed.hostname)) throw new UpdateError('network')
      resetIdle()
      const response = await transport(current, { redirect: 'manual', signal,
        headers: { 'User-Agent': 'Fy1Sync-Manual-Updater', 'Accept-Encoding': 'identity', Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } })
      if (externalSignal?.aborted) { await response.body?.cancel().catch(() => {}); throw new UpdateError('cancelled') }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 4) throw new UpdateError('network')
        current = new URL(location, current).href
        continue
      }
      if (response.status !== 200 || !response.body) throw new UpdateError('network', { cause: await httpErrorDetails(response) })
      if (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body.cancel(); throw new UpdateError('network') }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body.cancel(); throw new UpdateError('limit') }
      const reader = response.body.getReader()
      let count = 0
      try {
        for (;;) {
          resetIdle()
          const next = await reader.read()
          if (externalSignal?.aborted) throw new UpdateError('cancelled')
          if (controller.signal.aborted) throw new UpdateError('network')
          if (next.done) break
          count += next.value.byteLength
          if (count > limit) throw new UpdateError('limit')
          await consume(Buffer.from(next.value))
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (externalSignal?.aborted) throw new UpdateError('cancelled')
      if (!count || (length !== null && count !== Number(length))) throw new UpdateError('network')
      return
    }
    throw new UpdateError('network')
  } catch (error) {
    if (externalSignal?.aborted) throw new UpdateError('cancelled')
    if (error instanceof UpdateError) throw error
    throw new UpdateError('network', { cause: error })
  } finally { clearTimeout(idleTimer); clearTimeout(totalTimer) }
}
async function downloadBytes(url: string, limit: number, transport?: Transport, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  await officialDownload(url, limit, async bytes => { chunks.push(bytes) }, transport, signal)
  return Buffer.concat(chunks)
}
function release(value: unknown, assetName: YtdlpReleaseAsset): { version: string; exe: string; sums: string; size: number } {
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
  const exe = asset(assetName, MAX_EXE), sums = asset('SHA2-256SUMS', MAX_SUMS)
  return { version: r.tag_name, exe: exe.url, sums: sums.url, size: exe.size }
}
export function releaseChecksum(text: string, assetName: YtdlpReleaseAsset = 'yt-dlp.exe'): string {
  const escapedName = assetName.replaceAll('.', '\\.')
  const name = new RegExp(`(?:\\s|\\*)${escapedName}(?:\\s|$)`)
  const matches = text.split(/\r?\n/).filter(line => name.test(line))
  if (matches.length !== 1) throw new UpdateError('checksum')
  const match = new RegExp(`^([a-fA-F0-9]{64}) [ *]${escapedName}$`).exec(matches[0]!)
  if (!match) throw new UpdateError('checksum')
  return match[1]!.toLowerCase()
}

function samePhysicalPath(actual: string, expected: string): boolean {
  const a = path.resolve(actual), b = path.resolve(expected)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export class ManagedYtdlp implements ToolUpdaterService {
  private readonly root: string
  private readonly userData: string
  private readonly platform: NodeJS.Platform
  private readonly assetName: YtdlpReleaseAsset | undefined
  private readonly filename: string
  private manifest: Manifest = { schema: 1 }
  private initialized?: Promise<void>
  private flight?: Promise<ToolUpdateState>
  private abort?: AbortController
  private status: ToolUpdateState = { phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: '仅手动检查官方稳定版，启动时不联网' }
  constructor(userData: string, private readonly options: { transport?: Transport; verify?: (file: string) => Promise<string>; baselineVersion?: string; platform?: NodeJS.Platform; arch?: string } = {}) {
    this.userData = path.resolve(userData)
    this.root = path.join(userData, 'managed-tools', 'yt-dlp')
    this.platform = options.platform ?? process.platform
    this.assetName = ytdlpReleaseAsset(this.platform, options.arch ?? process.arch)
    // Distinct Windows architecture names prevent cross-architecture manifest reuse.
    this.filename = this.platform === 'darwin' ? 'yt-dlp' : this.assetName ?? 'unsupported'
  }
  state(): ToolUpdateState { return { ...this.status, activeVersion: this.manifest.active?.version, previousVersion: this.manifest.previous?.version } }
  private async safeRoot(create = false): Promise<string> {
    containedPath(this.userData, this.root)
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    // macOS system parents may be aliases (/var -> /private/var); the app subtree may not.
    const canonicalUserData = await realpath(this.userData)
    const actual = await realpath(this.root)
    const expected = path.join(canonicalUserData, path.relative(this.userData, this.root))
    if (!samePhysicalPath(actual, expected) || (await lstat(this.root)).isSymbolicLink()) throw new UpdateError('storage')
    return actual
  }
  private async valid(e?: Entry): Promise<string | undefined> {
    if (!e) return undefined
    try {
      const canonicalRoot = await this.safeRoot()
      if (!this.assetName) return undefined
      const dir = path.join(this.root, e.id), file = path.join(dir, this.filename)
      containedPath(this.userData, file)
      if ((await lstat(dir)).isSymbolicLink() || (await lstat(file)).isSymbolicLink()
        || !samePhysicalPath(await realpath(file), path.join(canonicalRoot, e.id, this.filename))) return undefined
      const s = await stat(file)
      if (!s.isFile() || s.size <= 0 || s.size > MAX_EXE || await sha256File(file) !== e.sha256) return undefined
      await access(file, this.platform === 'win32' ? constants.R_OK : constants.X_OK)
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
        if (m.active && !active) this.status.message = previous ? '已拒绝损坏的更新，回退到上一版本' : '已拒绝损坏的更新，使用内置工具'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.status.message = '更新记录无效，使用内置工具'
      }
    })()
  }
  async activePath(): Promise<string | undefined> {
    await this.init()
    const selected = await this.valid(this.manifest.active)
    if (selected) return selected
    if (this.manifest.active) {
      const fallback = await this.valid(this.manifest.previous)
      this.manifest = { schema: 1, ...(fallback ? { active: this.manifest.previous } : {}) }
      this.status.message = fallback ? '更新文件损坏，已回退上一版本' : '更新文件损坏，已回退内置工具'
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
    const abort = new AbortController()
    this.abort = abort
    this.flight = this.performUpdate(abort.signal).finally(() => {
      if (this.abort === abort) this.abort = undefined
      this.flight = undefined
    })
    return this.flight
  }
  async cancel(): Promise<ToolUpdateState> {
    if (!this.abort || !this.flight) return this.state()
    this.abort.abort()
    await this.flight.catch(() => {})
    return this.state()
  }
  private async performUpdate(signal: AbortSignal): Promise<ToolUpdateState> {
    let temporary: string | undefined, promoted: string | undefined, committed = false
    const checkCancelled = () => { if (signal.aborted) throw new UpdateError('cancelled') }
    try {
      if (!this.assetName) throw new UpdateError('release')
      await this.init()
      await this.activePath()
      checkCancelled()
      this.status = { phase: 'checking', downloadedBytes: 0, totalBytes: 0, message: '正在检查 GitHub 官方稳定版…' }
      let info: ReturnType<typeof release>
      try { info = release(JSON.parse((await downloadBytes(API, MAX_JSON, this.options.transport, signal)).toString('utf8')), this.assetName) }
      catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError('release', { cause: error }) }
      checkCancelled()
      const current = this.manifest.active?.version ?? this.options.baselineVersion
      if (current && info.version.localeCompare(current, 'en', { numeric: true }) <= 0) {
        this.status = { ...this.status, phase: 'current', message: 'yt-dlp 已是最新可用版本' }
        return this.state()
      }
      const checksum = releaseChecksum((await downloadBytes(info.sums, MAX_SUMS, this.options.transport, signal)).toString('utf8'), this.assetName)
      checkCancelled()
      await this.safeRoot(true)
      temporary = path.join(this.root, `download-${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o700)
      const hash = createHash('sha256')
      const startedAt = Date.now()
      let sampleAt = startedAt
      let sampleBytes = 0
      this.status = { phase: 'downloading', downloadedBytes: 0, totalBytes: info.size, bytesPerSecond: 0, downloadedVersion: info.version, message: '正在下载并校验…' }
      try {
        await officialDownload(info.exe, info.size, async bytes => {
          // FileHandle.write can be partial; writeFile with an open handle writes the complete chunk.
          await file.writeFile(bytes)
          hash.update(bytes)
          this.status.downloadedBytes += bytes.length
          const now = Date.now()
          const deltaMs = now - sampleAt
          if (deltaMs >= 300) {
            const instant = (this.status.downloadedBytes - sampleBytes) * 1000 / deltaMs
            this.status.bytesPerSecond = this.status.bytesPerSecond ? Math.round(this.status.bytesPerSecond * 0.6 + instant * 0.4) : Math.round(instant)
            sampleAt = now
            sampleBytes = this.status.downloadedBytes
          } else if (!this.status.bytesPerSecond && now > startedAt) {
            this.status.bytesPerSecond = Math.round(this.status.downloadedBytes * 1000 / (now - startedAt))
          }
        }, this.options.transport, signal)
        await file.sync()
      } finally { await file.close() }
      checkCancelled()
      if (this.status.downloadedBytes !== info.size || hash.digest('hex') !== checksum) throw new UpdateError('checksum')
      this.status = { phase: 'verifying', downloadedBytes: this.status.downloadedBytes, totalBytes: info.size, downloadedVersion: info.version, message: '下载校验通过，正在验证工具…' }
      // Windows needs the native executable extension for CreateProcess.
      // Short opaque directory names also avoid Windows CreateProcess MAX_PATH failures.
      const id = randomUUID()
      promoted = path.join(this.root, id)
      await mkdir(promoted, { mode: 0o700 })
      const executable = path.join(promoted, this.filename)
      await rename(temporary, executable)
      temporary = undefined
      if (this.platform !== 'win32') await chmod(executable, 0o700)
      let verified: string
      try { verified = await (this.options.verify ?? (file => toolVersion(file, true)))(executable) } catch (error) { throw new UpdateError('verification', { cause: error }) }
      checkCancelled()
      if (verified !== info.version) throw new UpdateError('verification')
      if (await sha256File(executable) !== checksum) throw new UpdateError('checksum')
      try { await access(executable, this.platform === 'win32' ? constants.R_OK : constants.X_OK) } catch (error) { throw new UpdateError('verification', { cause: error }) }
      checkCancelled()
      const previous = this.manifest.active ?? this.manifest.previous
      await this.save({ schema: 1, active: { id, version: info.version, sha256: checksum }, ...(previous ? { previous } : {}) })
      committed = true
      this.status = { phase: 'ready', downloadedBytes: info.size, totalBytes: info.size, downloadedVersion: info.version, message: `已更新至 ${info.version}，下次载入直播间生效` }
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : error instanceof UpdateError ? error.code : 'storage'
      if (code === 'cancelled') {
        this.status = { phase: 'cancelled', downloadedBytes: 0, totalBytes: 0, message: messages.cancelled }
      } else {
        this.status = { phase: 'error', downloadedBytes: this.status.downloadedBytes, totalBytes: this.status.totalBytes,
          ...(this.status.downloadedVersion ? { downloadedVersion: this.status.downloadedVersion } : {}),
          message: messages[code], errorDetail: diagnosticDetails(error) }
      }
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
        this.status = { phase: 'restored', downloadedBytes: 0, totalBytes: 0, message: '已恢复所选版本，下次载入直播间生效' }
      } catch (error) { this.status = { ...this.status, phase: 'error', message: messages.storage, errorDetail: diagnosticDetails(error) } }
      return this.state()
    })()
    this.flight = operation.finally(() => { this.flight = undefined })
    return this.flight
  }
}
