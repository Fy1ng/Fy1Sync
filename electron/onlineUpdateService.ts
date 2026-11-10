import fs from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { Resolver } from '../server/safeFetch'
import { compareAppVersions } from './appUpdateService'
import { PrivateJsonStore } from './privateJsonStore'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'
import { isUpdateVersion, parseOnlineUpdateSource, validateFrontendBundle, verifyOnlineUpdateCatalog } from './onlineUpdateManifest'
import { readUpdateDownload, streamUpdateDownload } from './updateDownload'
import { UPDATE_LIMITS, type ApplicationUpdateEntry, type FrontendSnapshot, type FrontendUpdateEntry, type FrontendUpdatePort, type OnlineUpdateCatalog, type OnlineUpdateItemState, type OnlineUpdateKind, type OnlineUpdateSource, type OnlineUpdateSourceId, type OnlineUpdateState, type SignedUpdateCatalog } from './onlineUpdateContracts'

const failure = () => new Error('在线更新的签名, 版本或本地校验记录无效.')
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const labels = { github: 'GitHub', gitcode: 'GitCode' } as const

export interface VerifiedUpdateProof { envelope: SignedUpdateCatalog; catalog: OnlineUpdateCatalog; hash: string }
export interface VerifiedUpdateArchive {
  latest: VerifiedUpdateProof
  frontendHigh: VerifiedUpdateProof | null
  applicationHigh: VerifiedUpdateProof | null
  checkedAt: number | null
}
interface StoredArchive {
  schemaVersion: 1
  latest: SignedUpdateCatalog
  frontendHigh: SignedUpdateCatalog | null
  applicationHigh: SignedUpdateCatalog | null
  checkedAt: number | null
}

function proof(raw: unknown, source: OnlineUpdateSource): VerifiedUpdateProof {
  const catalog = verifyOnlineUpdateCatalog(raw, source)
  const envelope = { payload: (raw as SignedUpdateCatalog).payload, signature: (raw as SignedUpdateCatalog).signature }
  return { envelope, catalog, hash: digest(Buffer.from(envelope.payload, 'base64')) }
}

/** Used by startup as well: a withdrawn pending frontend must not survive a crash. */
export function readVerifiedUpdateArchive(userDataDir: string, source: OnlineUpdateSource): VerifiedUpdateArchive | null {
  const raw = new PrivateJsonStore<StoredArchive>(userDataDir, 'online-updates/catalog.json').load()
  if (raw === undefined) return null
  if (!object(raw) || Object.keys(raw).sort().join(',') !== 'applicationHigh,checkedAt,frontendHigh,latest,schemaVersion'
    || raw.schemaVersion !== 1 || raw.checkedAt !== null && (!Number.isSafeInteger(raw.checkedAt) || (raw.checkedAt as number) < 0)) throw failure()
  const latest = proof(raw.latest, source)
  const frontendHigh = raw.frontendHigh === null ? null : proof(raw.frontendHigh, source)
  const applicationHigh = raw.applicationHigh === null ? null : proof(raw.applicationHigh, source)
  if (frontendHigh && (!frontendHigh.catalog.frontend || frontendHigh.catalog.revision > latest.catalog.revision)
    || applicationHigh && (!applicationHigh.catalog.application || applicationHigh.catalog.revision > latest.catalog.revision)
    || latest.catalog.frontend && !same(latest.catalog.frontend, frontendHigh?.catalog.frontend)
    || latest.catalog.application && !same(latest.catalog.application, applicationHigh?.catalog.application)) throw failure()
  const proofs = [latest, frontendHigh, applicationHigh].filter((value): value is VerifiedUpdateProof => value !== null)
  for (const value of proofs) {
    if (proofs.some(other => other.catalog.revision === value.catalog.revision && other.hash !== value.hash)) throw failure()
    const front = value.catalog.frontend, app = value.catalog.application
    const highestFront = frontendHigh?.catalog.frontend, highestApp = applicationHigh?.catalog.application
    if (front && (!highestFront || front.revision > highestFront.revision || front.revision === highestFront.revision && !same(front, highestFront))
      || app && (!highestApp || compareAppVersions(app.version, highestApp.version) > 0 || compareAppVersions(app.version, highestApp.version) === 0 && !same(app, highestApp))) throw failure()
  }
  return { latest, frontendHigh, applicationHigh, checkedAt: raw.checkedAt as number | null }
}

export interface OnlineUpdateServiceOptions {
  userDataDir: string
  source: OnlineUpdateSource | null
  currentAppVersion: string
  bridgeVersion: number
  frontend: FrontendUpdatePort
  installSupported: boolean
  request?: typeof fetch
  resolve?: Resolver
  now?: () => number
}

function item(phase: OnlineUpdateItemState['phase'], message: string, entry: FrontendUpdateEntry | ApplicationUpdateEntry | null = null): OnlineUpdateItemState {
  return { phase, message, version: entry?.version ?? null, revision: entry && 'revision' in entry ? entry.revision : null,
    notes: entry?.notes ?? null, downloadedBytes: phase === 'ready' ? entry?.bytes ?? 0 : 0, totalBytes: entry?.bytes ?? null }
}

/** Downloads trusted artifacts only. Native dialogs, restart and execution stay in main. */
export class OnlineUpdateService {
  private readonly source: OnlineUpdateSource | null
  private readonly listeners = new Set<(state: OnlineUpdateState) => void>()
  private readonly lifetime = new AbortController()
  private archive: VerifiedUpdateArchive | null = null
  private readyInstaller: VerifiedUpdateProof | null = null
  private initial: Promise<void> = Promise.resolve()
  private flight: Promise<OnlineUpdateState> | null = null
  private controller: AbortController | null = null
  private activeKind: OnlineUpdateKind | 'check' | null = null
  private progress: OnlineUpdateItemState | null = null
  private committing = false
  private verifyingInstaller = false
  private disposed = false
  private cacheInvalid = false
  private selected: OnlineUpdateSourceId = 'github'
  private phase: OnlineUpdateState['phase'] = 'idle'
  private message = '手动检查更新. 下载不会中断当前播放.'
  private checkedAt: number | null = null

  constructor(private readonly options: OnlineUpdateServiceOptions) {
    this.source = parseOnlineUpdateSource(options.source)
    if (!isUpdateVersion(options.currentAppVersion) || !Number.isSafeInteger(options.bridgeVersion) || options.bridgeVersion < 1) throw failure()
    const sources = this.source?.mirrors.map(value => value.id) ?? []
    this.selected = sources.includes('github') ? 'github' : sources[0] ?? 'github'
    if (!this.source) {
      this.phase = 'unconfigured'
      this.message = '尚未配置签名在线更新来源.'
      return
    }
    try {
      const preference = new PrivateJsonStore<{ source: OnlineUpdateSourceId }>(options.userDataDir, 'online-updates/source.json').load()
      if (object(preference) && Object.keys(preference).length === 1 && sources.includes(preference.source as OnlineUpdateSourceId)) this.selected = preference.source as OnlineUpdateSourceId
    } catch { /* An invalid preference cannot replace the embedded trusted source list. */ }
    try {
      this.archive = readVerifiedUpdateArchive(options.userDataDir, this.source)
      this.checkedAt = this.archive?.checkedAt ?? null
    } catch {
      this.cacheInvalid = true
      this.phase = 'error'
      this.message = '本地更新校验记录损坏. 已停止在线更新并保留原文件, 当前应用仍可使用.'
    }
    if (!this.cacheInvalid) this.initial = this.restoreInstaller()
  }

  state(): OnlineUpdateState {
    const snapshot = this.options.frontend.snapshot()
    return { phase: this.phase, source: this.selected, availableSources: this.source?.mirrors.map(value => value.id) ?? [],
      currentAppVersion: this.options.currentAppVersion, currentFrontendRevision: snapshot.currentRevision, bridgeVersion: this.options.bridgeVersion,
      checkedAt: this.checkedAt, canRollbackFrontend: snapshot.canRollback,
      frontend: this.activeKind === 'frontend' && this.progress ? { ...this.progress } : this.frontendItem(snapshot),
      application: this.activeKind === 'application' && this.progress ? { ...this.progress } : this.applicationItem(), message: this.message }
  }

  subscribe(listener: (state: OnlineUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try { listener(this.state()) } catch { /* Observers cannot invalidate committed updates. */ }
    }
  }

  private frontendItem(snapshot: FrontendSnapshot): OnlineUpdateItemState {
    if (snapshot.phase === 'trial') return { ...item('trial', snapshot.message || '正在确认新版前端能正常启动.'), version: snapshot.currentVersion, revision: snapshot.currentRevision }
    if (snapshot.staged) return item('ready', '前端包已验签. 下次启动时应用, 也可主动重启应用.', snapshot.staged)
    const entry = this.archive?.latest.catalog.frontend ?? null
    if (!this.source) return item('unavailable', '尚未配置签名前端更新来源.')
    if (!entry || entry.revision <= snapshot.currentRevision) return { ...item(snapshot.phase === 'rolled-back' ? 'rolled-back' : 'current', snapshot.message || '当前没有新的前端更新.'), version: snapshot.currentVersion, revision: snapshot.currentRevision }
    if (entry.revision <= snapshot.blockedRevision) return item('rolled-back', '此版本已失败或被手动回退, 不会再次自动启用. 请等待更高版本.', entry)
    if (!this.compatible(entry)) return item('incompatible', '此前端包与当前客户端或 IPC 版本不匹配, 请先更新完整应用.', entry)
    return item('available', '可独立更新界面, 无需重新下载安装包.', entry)
  }

  private applicationItem(): OnlineUpdateItemState {
    const entry = this.archive?.latest.catalog.application ?? null
    if (!entry) return item('unavailable', '暂未发布可用的完整应用更新.')
    if (compareAppVersions(entry.version, this.options.currentAppVersion) <= 0) return item('current', '当前完整应用已是最新可用版本.', entry)
    if (!this.options.installSupported) return item('incompatible', '此运行方式不支持应用内安装. 请从发布页下载适用于当前系统的完整应用包.', entry)
    if (this.readyInstaller && same(this.readyInstaller.catalog.application, entry)) return item('ready', '安装包已下载并通过校验. 只有明确确认后才会退出应用并打开安装向导.', entry)
    if (!entry.downloads[this.selected]) return item('incompatible', '所选来源尚未提供此安装包. 可手动选择其他来源.', entry)
    return item('available', '可下载完整应用更新. 下载不会退出应用或自动安装.', entry)
  }

  private compatible(entry: FrontendUpdateEntry): boolean {
    return entry.bridgeVersion === this.options.bridgeVersion && compareAppVersions(this.options.currentAppVersion, entry.minAppVersion) >= 0
      && compareAppVersions(this.options.currentAppVersion, entry.maxAppVersion) <= 0
  }

  setSource(id: OnlineUpdateSourceId): OnlineUpdateState {
    if (!this.source?.mirrors.some(value => value.id === id)) throw new Error('该在线更新来源未配置.')
    if (this.disposed || this.flight || this.verifyingInstaller) throw new Error('正在处理在线更新, 请完成后再切换来源.')
    if (id === this.selected) return this.state()
    new PrivateJsonStore<{ source: OnlineUpdateSourceId }>(this.options.userDataDir, 'online-updates/source.json').save({ source: id })
    this.selected = id
    if (!this.cacheInvalid) {
      this.phase = 'idle'
      this.message = `已选择 ${labels[id]}, 点击检查更新读取该源. 不会自动切换来源.`
    }
    this.publish()
    return this.state()
  }

  check(): Promise<OnlineUpdateState> {
    return this.run('check', async signal => {
      const mirror = this.source!.mirrors.find(value => value.id === this.selected)!
      this.phase = 'checking'
      this.message = `正在从 ${labels[this.selected]} 检查签名更新清单.`
      this.publish()
      const bytes = await readUpdateDownload(mirror.manifestUrl, this.transport(signal, UPDATE_LIMITS.catalogBytes))
      const incoming = proof(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, this.source!)
      const previous = this.archive
      if (previous && (incoming.catalog.revision < previous.latest.catalog.revision || incoming.catalog.revision === previous.latest.catalog.revision && incoming.hash !== previous.latest.hash)) throw failure()
      const frontHigh = previous?.frontendHigh?.catalog.frontend
      const appHigh = previous?.applicationHigh?.catalog.application
      const front = incoming.catalog.frontend, app = incoming.catalog.application
      if (front && frontHigh && (front.revision < frontHigh.revision || front.revision === frontHigh.revision && !same(front, frontHigh))) throw failure()
      if (app && appHigh && (compareAppVersions(app.version, appHigh.version) < 0 || compareAppVersions(app.version, appHigh.version) === 0 && !same(app, appHigh))) throw failure()
      const now = this.now()
      const archive: VerifiedUpdateArchive = { latest: incoming, frontendHigh: front ? incoming : previous?.frontendHigh ?? null,
        applicationHigh: app ? incoming : previous?.applicationHigh ?? null, checkedAt: now }
      signal.throwIfAborted()
      this.committing = true
      new PrivateJsonStore<StoredArchive>(this.options.userDataDir, 'online-updates/catalog.json').save({ schemaVersion: 1,
        latest: archive.latest.envelope, frontendHigh: archive.frontendHigh?.envelope ?? null, applicationHigh: archive.applicationHigh?.envelope ?? null, checkedAt: now })
      this.archive = archive
      this.checkedAt = now
      if (this.readyInstaller && !same(this.readyInstaller.catalog.application, app)) this.readyInstaller = null
      const staged = this.options.frontend.snapshot().staged
      if (staged && !same(staged, front)) {
        try { await this.options.frontend.discardStaged() }
        catch { this.cacheInvalid = true; throw failure() }
      }
      this.phase = 'idle'
      this.message = `已检查 ${labels[this.selected]} 的签名更新. 下载不会中断当前播放.`
    })
  }

  download(kind: OnlineUpdateKind): Promise<OnlineUpdateState> {
    if (kind !== 'frontend' && kind !== 'application') return Promise.reject(new Error('更新类型无效.'))
    return this.run(kind, async signal => {
      const available = kind === 'frontend' ? this.frontendItem(this.options.frontend.snapshot()) : this.applicationItem()
      if (available.phase !== 'available') return
      const current = this.archive!.latest
      const entry = kind === 'frontend' ? current.catalog.frontend! : current.catalog.application!
      this.progress = item('downloading', kind === 'frontend' ? '正在下载并验证前端包.' : '正在下载并验证完整安装包.', entry)
      this.phase = 'idle'
      this.message = '正在下载签名更新. 当前播放不会受到影响.'
      this.publish()
      let reportedAt = 0
      const progress = (count: number) => {
        if (!this.progress) return
        this.progress = { ...this.progress, downloadedBytes: count }
        const time = Date.now()
        if (time - reportedAt >= 100 || count === entry.bytes) { reportedAt = time; this.publish() }
      }
      if (kind === 'frontend') {
        const front = current.catalog.frontend!
        const mirror = this.source!.mirrors.find(value => value.id === this.selected)!
        const bytes = await readUpdateDownload(new URL(front.path, mirror.manifestUrl).href, {
          ...this.transport(signal, front.bytes), expectedBytes: front.bytes, timeoutMs: 120_000, onProgress: progress,
        })
        if (digest(bytes) !== front.sha256) throw failure()
        validateFrontendBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, front)
        signal.throwIfAborted()
        this.committing = true
        await this.options.frontend.stage(front, current.envelope, bytes)
        this.message = '前端更新已安全保存, 下次启动时应用. 现在无需重新下载安装包.'
      } else {
        await this.downloadInstaller(current, signal, progress)
        this.message = '完整安装包已下载并校验. 只有明确确认后才会退出应用并打开安装向导.'
      }
      this.phase = 'idle'
    })
  }

  private run(kind: OnlineUpdateKind | 'check', operation: (signal: AbortSignal) => Promise<void>): Promise<OnlineUpdateState> {
    if (this.flight) return this.flight
    if (this.disposed || !this.source || this.cacheInvalid || this.verifyingInstaller) return Promise.resolve(this.state())
    const controller = new AbortController()
    this.controller = controller
    this.activeKind = kind
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const pending = Promise.resolve().then(async () => {
      await this.initial
      signal.throwIfAborted()
      await operation(signal)
    }).catch(() => {
      if (controller.signal.aborted && !this.disposed) {
        this.phase = 'idle'
        this.message = '已取消更新操作. 原版本和已完成验证的更新仍保留.'
      } else {
        this.phase = 'error'
        this.message = this.cacheInvalid ? '本地更新切换未能安全完成. 已停止在线更新, 下次启动不会启用已撤回的前端包.'
          : `${kind === 'check' ? '更新检查' : '更新下载或校验'}失败. 已保留原版本和已验证缓存, 请重试或手动选择其他来源.`
      }
    }).then(() => {
      this.progress = null
      this.activeKind = null
      this.committing = false
      this.controller = null
      this.flight = null
      this.publish()
      return this.state()
    })
    this.flight = pending
    return pending
  }

  cancel(): Promise<OnlineUpdateState> {
    // Once the validated artifact is atomically committed, report that result rather than
    // claiming cancellation and discarding a successfully staged update.
    if (this.flight && !this.committing) this.controller?.abort()
    return this.flight ?? Promise.resolve(this.state())
  }

  private transport(signal: AbortSignal, limit: number) {
    return { signal, limit, request: this.options.request, resolve: this.options.resolve }
  }

  private now(): number {
    const now = (this.options.now ?? Date.now)()
    return Number.isSafeInteger(now) && now >= 0 ? now : Date.now()
  }

  private installerFile(entry: ApplicationUpdateEntry): string {
    return containedPath(this.options.userDataDir, path.join(this.options.userDataDir, 'online-updates', 'installers', `${entry.sha256}.exe`))
  }

  private async verifyInstaller(entry: ApplicationUpdateEntry): Promise<string> {
    const file = this.installerFile(entry)
    assertRegularPath(file, false)
    const descriptor = await open(file, 'r')
    try {
      const before = await descriptor.stat()
      if (!before.isFile() || before.size !== entry.bytes || before.nlink !== 1) throw failure()
      const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
      let size = 0
      for (;;) {
        this.lifetime.signal.throwIfAborted()
        const result = await descriptor.read(buffer, 0, buffer.length, null)
        if (!result.bytesRead) break
        size += result.bytesRead
        if (size > entry.bytes || size > UPDATE_LIMITS.installerBytes) throw failure()
        hash.update(buffer.subarray(0, result.bytesRead))
      }
      const after = await descriptor.stat()
      if (size !== entry.bytes || before.mtimeMs !== after.mtimeMs || after.size !== entry.bytes || hash.digest('hex') !== entry.sha256) throw failure()
      const currentFile = this.installerFile(entry)
      assertRegularPath(currentFile, false)
      const current = fs.statSync(currentFile)
      if (current.dev !== after.dev || current.ino !== after.ino || current.nlink !== 1 || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw failure()
      return file
    } finally { await descriptor.close() }
  }

  private async restoreInstaller(): Promise<void> {
    try {
      const raw = new PrivateJsonStore<unknown>(this.options.userDataDir, 'online-updates/installer.json').load()
      if (raw === undefined) return
      if (!object(raw) || Object.keys(raw).sort().join(',') !== 'envelope,schemaVersion' || raw.schemaVersion !== 1) throw failure()
      const candidate = proof(raw.envelope, this.source!)
      const entry = candidate.catalog.application
      if (!entry || !same(entry, this.archive?.latest.catalog.application) || compareAppVersions(entry.version, this.options.currentAppVersion) <= 0) return
      await this.verifyInstaller(entry)
      if (!this.disposed) { this.readyInstaller = candidate; this.publish() }
    } catch {
      if (!this.disposed) {
        this.phase = 'error'
        this.message = '已下载的安装包未通过本地校验, 不会执行. 可重新下载, 当前应用仍可使用.'
        this.publish()
      }
    }
  }

  private async downloadInstaller(current: VerifiedUpdateProof, signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
    const entry = current.catalog.application!, download = entry.downloads[this.selected]!
    if (!this.options.installSupported || !download || compareAppVersions(entry.version, this.options.currentAppVersion) <= 0) throw failure()
    const directory = privateDirectory(this.options.userDataDir, path.join(this.options.userDataDir, 'online-updates', 'installers'))
    let temporary: string | null = containedPath(this.options.userDataDir, path.join(directory, `.download-${randomUUID()}.tmp`))
    let descriptor: Awaited<ReturnType<typeof open>> | null = null
    try {
      descriptor = await open(temporary, 'wx', 0o600)
      const hash = createHash('sha256')
      await streamUpdateDownload(download.url, { ...this.transport(signal, entry.bytes), expectedBytes: entry.bytes,
        redirectOrigins: download.redirectOrigins, timeoutMs: 15 * 60_000, onProgress }, async chunk => {
        let written = 0
        while (written < chunk.byteLength) {
          const result = await descriptor!.write(chunk, written, chunk.byteLength - written, null)
          if (!result.bytesWritten) throw failure()
          written += result.bytesWritten
        }
        hash.update(chunk)
      })
      if (hash.digest('hex') !== entry.sha256) throw failure()
      await descriptor.sync()
      await descriptor.close()
      descriptor = null
      signal.throwIfAborted()
      this.committing = true
      const target = this.installerFile(entry)
      if (fs.existsSync(target)) assertRegularPath(target, false)
      assertRegularPath(containedPath(this.options.userDataDir, temporary), false)
      await rename(temporary, target)
      temporary = null
      new PrivateJsonStore<{ schemaVersion: 1; envelope: SignedUpdateCatalog }>(this.options.userDataDir, 'online-updates/installer.json').save({ schemaVersion: 1, envelope: current.envelope })
      this.readyInstaller = current
    } finally {
      await descriptor?.close().catch(() => {})
      if (temporary) {
        const safe = containedPath(this.options.userDataDir, temporary)
        if (fs.existsSync(safe)) { assertRegularPath(safe, false); await unlink(safe) }
      }
    }
  }

  async installerPath(): Promise<string> {
    if (this.disposed || this.flight || this.verifyingInstaller || this.cacheInvalid) throw new Error('当前不能执行完整应用更新.')
    this.verifyingInstaller = true
    try {
      await this.initial
      const entry = this.archive?.latest.catalog.application
      if (!this.options.installSupported || !entry || !this.readyInstaller || !same(entry, this.readyInstaller.catalog.application)
        || compareAppVersions(entry.version, this.options.currentAppVersion) <= 0) throw failure()
      if (!same(proof(this.readyInstaller.envelope, this.source!).catalog.application, entry)) throw failure()
      return await this.verifyInstaller(entry)
    } catch {
      this.readyInstaller = null
      this.phase = 'error'
      this.message = '安装包的执行前校验失败, 没有启动安装程序. 请重新下载.'
      throw new Error('安装包不可用或未通过执行前校验.')
    } finally { this.verifyingInstaller = false; this.publish() }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    this.controller?.abort()
    this.listeners.clear()
  }
}
