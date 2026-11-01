import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual, TextDecoder } from 'node:util'
import { compareAppVersions } from './appUpdateService'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'
import { PrivateJsonStore } from './privateJsonStore'
import { parseOnlineUpdateSource, validateFrontendBundle, verifyOnlineUpdateCatalog } from './onlineUpdateManifest'
import { readVerifiedUpdateArchive } from './onlineUpdateService'
import { UPDATE_LIMITS, type FrontendBundle, type FrontendSnapshot, type FrontendUpdateEntry, type FrontendUpdatePort, type OnlineUpdateSource, type SignedUpdateCatalog } from './onlineUpdateContracts'

interface Selection {
  schemaVersion: 1
  active: string | null
  previous: string | null
  pending: string | null
  trial: { candidate: string; previous: string | null } | null
  blockedRevision: number
}
interface Release { hash: string; entry: FrontendUpdateEntry; root: string }
interface Options {
  userDataDir: string
  bundledClientDir: string
  source: OnlineUpdateSource | null
  currentAppVersion: string
  bridgeVersion: number
  bundledRevision: number
}
const failure = () => new Error('前端更新缓存无效, 已保留原客户端和用户数据.')
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isReference = (value: unknown): value is string | null => value === null || isHash(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const emptySelection = (): Selection => ({ schemaVersion: 1, active: null, previous: null, pending: null, trial: null, blockedRevision: 0 })

function parseSelection(value: unknown): Selection {
  if (!object(value) || !exact(value, ['schemaVersion', 'active', 'previous', 'pending', 'trial', 'blockedRevision'])
    || value.schemaVersion !== 1 || !isReference(value.active) || !isReference(value.previous) || !isReference(value.pending)
    || !Number.isSafeInteger(value.blockedRevision) || (value.blockedRevision as number) < 0) throw failure()
  const trial = value.trial
  if (trial !== null && (!object(trial) || !exact(trial, ['candidate', 'previous']) || !isHash(trial.candidate) || !isReference(trial.previous))) throw failure()
  return { schemaVersion: 1, active: value.active, previous: value.previous, pending: value.pending,
    trial: trial as Selection['trial'], blockedRevision: value.blockedRevision as number }
}

/** The bundled client is immutable. Only authenticated, complete asset trees can replace it. */
export class FrontendUpdates implements FrontendUpdatePort {
  private readonly source: OnlineUpdateSource | null
  private readonly store: PrivateJsonStore<Selection>
  private selection = emptySelection()
  private running: Release | null = null
  private phase: FrontendSnapshot['phase'] = 'bundled'
  private message = '当前使用安装包内置界面.'
  private booted = false
  private disposed = false

  constructor(private readonly options: Options) {
    if (!Number.isSafeInteger(options.bundledRevision) || options.bundledRevision < 1 || !Number.isSafeInteger(options.bridgeVersion) || options.bridgeVersion < 1) throw failure()
    compareAppVersions(options.currentAppVersion, options.currentAppVersion)
    this.source = parseOnlineUpdateSource(options.source)
    this.store = new PrivateJsonStore(options.userDataDir, 'online-updates/frontend/selection.json')
    if (this.source) {
      try {
        const raw = this.store.load()
        if (raw !== undefined) this.selection = parseSelection(raw)
      } catch { this.phase = 'rolled-back'; this.message = '前端更新记录损坏, 已使用内置界面, 原记录和用户数据已保留.' }
    }
  }

  private file(relative: string): string { return containedPath(this.options.userDataDir, path.join(this.options.userDataDir, 'online-updates/frontend', relative)) }
  private read(relative: string, maximum: number): Buffer {
    const file = this.file(relative)
    assertRegularPath(file, false)
    if (fs.statSync(file).size > maximum) throw failure()
    return fs.readFileSync(file)
  }
  private compatible(entry: FrontendUpdateEntry): boolean {
    return entry.bridgeVersion === this.options.bridgeVersion && entry.revision > this.options.bundledRevision
      && compareAppVersions(this.options.currentAppVersion, entry.minAppVersion) >= 0
      && compareAppVersions(this.options.currentAppVersion, entry.maxAppVersion) <= 0
  }
  private proof(hash: string): { entry: FrontendUpdateEntry; envelope: SignedUpdateCatalog; catalogRevision: number } {
    if (!this.source || !isHash(hash)) throw failure()
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.read(`releases/${hash}/proof.json`, UPDATE_LIMITS.catalogBytes)))
    const catalog = verifyOnlineUpdateCatalog(envelope, this.source)
    const entry = catalog.frontend
    if (!entry || entry.sha256 !== hash) throw failure()
    return { entry, envelope: envelope as SignedUpdateCatalog, catalogRevision: catalog.revision }
  }
  private authenticate(hash: string): Release {
    const { entry } = this.proof(hash)
    if (!this.compatible(entry)) throw failure()
    const bytes = this.read(`releases/${hash}/bundle.json`, UPDATE_LIMITS.frontendBytes)
    if (bytes.length !== entry.bytes || hashOf(bytes) !== entry.sha256) throw failure()
    const bundle = validateFrontendBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, entry)
    const root = this.file(`releases/${hash}/client`)
    assertRegularPath(root, true)
    const expected = new Map(bundle.files.map(file => [file.path, Buffer.from(file.content, 'base64')]))
    const inspect = (directory: string, prefix: string) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + item.name
        const absolute = containedPath(this.options.userDataDir, path.join(directory, item.name))
        if (item.isSymbolicLink()) throw failure()
        if (!prefix && item.name === 'assets' && item.isDirectory()) { inspect(absolute, 'assets/'); continue }
        const original = expected.get(relative)
        if (!item.isFile() || !original || fs.statSync(absolute).size !== original.length || !fs.readFileSync(absolute).equals(original)) throw failure()
        expected.delete(relative)
      }
    }
    inspect(root, '')
    if (expected.size) throw failure()
    return { hash, entry, root }
  }
  private usable(hash: string | null): Release | null {
    if (hash === null || !this.source) return null
    try { return this.authenticate(hash) } catch { return null }
  }
  private revision(hash: string | null): number {
    if (!hash) return 0
    try { return this.proof(hash).entry.revision } catch { return 0 }
  }
  private pendingAllowed(hash: string): boolean {
    try {
      const proof = this.proof(hash)
      const archive = readVerifiedUpdateArchive(this.options.userDataDir, this.source!)
      return !archive || archive.latest.catalog.revision < proof.catalogRevision || isDeepStrictEqual(archive.latest.catalog.frontend, proof.entry)
    } catch { return false }
  }
  private save(next: Selection): void { this.store.save(next); this.selection = next }

  /** Persist a trial marker before any updated JavaScript is served, including after a crash. */
  beginBoot(): string {
    if (this.booted) return this.clientDir()
    this.booted = true
    if (!this.source) return this.clientDir()
    if (this.selection.trial) {
      const trial = this.selection.trial
      this.running = this.usable(trial.previous)
      const next: Selection = { ...this.selection, active: this.running?.hash ?? null, trial: null, pending: null,
        blockedRevision: Math.max(this.selection.blockedRevision, this.revision(trial.candidate)) }
      try { this.save(next) } catch { this.selection = next }
      this.phase = 'rolled-back'
      this.message = '上次前端启动未完成, 已自动回退到可用界面, 不会再次应用该版本.'
      return this.clientDir()
    }
    this.running = this.usable(this.selection.active)
    if (this.selection.active && !this.running) {
      this.running = this.usable(this.selection.previous)
      const next: Selection = { ...this.selection, active: this.running?.hash ?? null, previous: null,
        blockedRevision: Math.max(this.selection.blockedRevision, this.revision(this.selection.active)) }
      try { this.save(next) } catch { this.selection = next }
      this.phase = 'rolled-back'
      this.message = '缓存界面损坏或不兼容当前客户端, 已自动回退, 用户数据不受影响.'
    } else if (this.running) { this.phase = 'current'; this.message = '当前使用已验签的前端更新.' }

    if (this.selection.pending) {
      const candidate = this.pendingAllowed(this.selection.pending) ? this.usable(this.selection.pending) : null
      if (candidate && candidate.entry.revision > Math.max(this.snapshot().currentRevision, this.selection.blockedRevision)) {
        const next: Selection = { ...this.selection, pending: null, trial: { candidate: candidate.hash, previous: this.running?.hash ?? null } }
        try {
          this.save(next)
          this.running = candidate
          this.phase = 'trial'
          this.message = '正在验证新界面能否正常启动, 失败将自动回退.'
        } catch { this.message = '无法记录前端启动状态, 继续使用原界面.' }
      } else {
        const next: Selection = { ...this.selection, pending: null, blockedRevision: Math.max(this.selection.blockedRevision, this.revision(this.selection.pending)) }
        try { this.save(next) } catch { this.selection = next }
        this.phase = 'rolled-back'
        this.message = '待应用的前端包损坏或不兼容, 已保留原界面.'
      }
    }
    return this.clientDir()
  }

  clientDir(): string { return this.running?.root ?? this.options.bundledClientDir }
  snapshot(): FrontendSnapshot {
    let staged: FrontendUpdateEntry | null = null
    if (this.selection.pending) {
      try {
        const { entry } = this.proof(this.selection.pending)
        if (this.compatible(entry) && entry.revision > this.selection.blockedRevision) staged = entry
      } catch { /* Incomplete candidates are not advertised as ready. */ }
    }
    return { currentRevision: this.running?.entry.revision ?? this.options.bundledRevision,
      currentVersion: this.running?.entry.version ?? this.options.currentAppVersion,
      phase: this.phase, staged, canRollback: !!this.running || !!staged,
      blockedRevision: this.selection.blockedRevision, message: this.message }
  }

  private async writeNew(target: string, bytes: Uint8Array): Promise<void> {
    if (this.disposed) throw failure()
    const file = containedPath(this.options.userDataDir, target)
    const descriptor = await fs.promises.open(file, 'wx', 0o600)
    try { await descriptor.writeFile(bytes); await descriptor.sync() } finally { await descriptor.close() }
  }
  private removeCacheTree(target: string): void {
    const parent = this.file('releases')
    const absolute = containedPath(parent, target)
    if (path.dirname(absolute) !== parent || !/^(?:[a-f0-9]{64}|\.[a-f0-9]{64}-[a-f0-9-]+\.tmp)$/.test(path.basename(absolute))) throw failure()
    assertRegularPath(absolute, true)
    const inspect = (directory: string) => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = containedPath(absolute, path.join(directory, item.name))
        if (item.isSymbolicLink()) throw failure()
        if (item.isDirectory()) inspect(file)
        else assertRegularPath(file, false)
      }
    }
    inspect(absolute)
    fs.rmSync(absolute, { recursive: true, force: true })
  }
  private collect(): void {
    const keep = new Set([this.running?.hash, this.selection.active, this.selection.previous, this.selection.pending,
      this.selection.trial?.candidate, this.selection.trial?.previous])
    try {
      const directory = this.file('releases')
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!item.isDirectory() || item.isSymbolicLink() || !isHash(item.name) || keep.has(item.name)) continue
        try { this.proof(item.name); this.removeCacheTree(path.join(directory, item.name)) } catch { /* Keep unfamiliar or unsafe files untouched. */ }
      }
    } catch { /* Cache collection must not invalidate the active release. */ }
  }
  async stage(entry: FrontendUpdateEntry, envelope: SignedUpdateCatalog, bytes: Uint8Array): Promise<void> {
    if (this.disposed || !this.source || this.phase === 'trial') throw failure()
    const authenticated = verifyOnlineUpdateCatalog(envelope, this.source).frontend
    if (!authenticated || !isDeepStrictEqual(authenticated, entry) || !this.compatible(entry)
      || entry.revision <= Math.max(this.snapshot().currentRevision, this.selection.blockedRevision)
      || bytes.length !== entry.bytes || bytes.length > UPDATE_LIMITS.frontendBytes || hashOf(bytes) !== entry.sha256) throw failure()
    const bundle: FrontendBundle = validateFrontendBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, entry)
    const directory = privateDirectory(this.options.userDataDir, this.file('releases'))
    const target = this.file(`releases/${entry.sha256}`)
    let temporary: string | null = null
    try {
      if (fs.existsSync(target)) this.authenticate(entry.sha256)
      else {
        temporary = this.file(`releases/.${entry.sha256}-${randomUUID()}.tmp`)
        privateDirectory(this.options.userDataDir, temporary)
        const client = privateDirectory(this.options.userDataDir, path.join(temporary, 'client'))
        privateDirectory(this.options.userDataDir, path.join(client, 'assets'))
        await this.writeNew(path.join(temporary, 'proof.json'), Buffer.from(JSON.stringify(envelope)))
        await this.writeNew(path.join(temporary, 'bundle.json'), bytes)
        for (const file of bundle.files) await this.writeNew(path.join(client, file.path), Buffer.from(file.content, 'base64'))
        if (this.disposed) throw failure()
        containedPath(directory, temporary)
        containedPath(directory, target)
        fs.renameSync(temporary, target)
        temporary = null
        this.authenticate(entry.sha256)
      }
      if (this.disposed) throw failure()
      this.save({ ...this.selection, pending: entry.sha256 })
      this.collect()
    } finally {
      if (temporary) { try { this.removeCacheTree(temporary) } catch { /* An unsafe partial cache is never activated. */ } }
    }
  }

  async discardStaged(): Promise<void> {
    if (this.disposed) throw failure()
    if (this.selection.pending) { this.save({ ...this.selection, pending: null }); this.collect() }
  }

  confirmHealthy(bridgeVersion: number): boolean {
    if (this.disposed || bridgeVersion !== this.options.bridgeVersion) return false
    const trial = this.selection.trial
    if (!trial) return this.phase !== 'trial'
    if (!this.running || trial.candidate !== this.running.hash) return false
    try {
      this.save({ ...this.selection, active: trial.candidate, previous: trial.previous, trial: null })
      this.phase = 'current'
      this.message = '新界面已正常启动, 已保留上一版供回退.'
      this.collect()
      return true
    } catch { return false }
  }

  /** Used for a load error or watchdog timeout, before the candidate becomes known-good. */
  failBoot(): boolean {
    const trial = this.selection.trial
    if (this.disposed || this.phase !== 'trial' || !trial) return false
    const fallback = this.usable(trial.previous)
    const next: Selection = { ...this.selection, active: fallback?.hash ?? null, pending: null, trial: null,
      blockedRevision: Math.max(this.selection.blockedRevision, this.running?.entry.revision ?? this.revision(trial.candidate)) }
    try { this.save(next) } catch { this.selection = next }
    this.running = fallback
    this.phase = 'rolled-back'
    this.message = '新界面未能正常启动, 已自动回退, 不会再次应用该版本.'
    return true
  }

  /** The caller obtains explicit native confirmation and restarts after this succeeds. */
  rollbackForRestart(): void {
    if (this.disposed || !this.snapshot().canRollback) throw failure()
    const candidate = this.selection.trial?.candidate ?? this.running?.hash
    const fallback = candidate ? this.usable(this.selection.trial ? this.selection.trial.previous : this.selection.previous) : this.running
    this.save({ ...this.selection, active: fallback?.hash ?? null, previous: null, pending: null, trial: null,
      blockedRevision: Math.max(this.selection.blockedRevision, this.revision(candidate ?? null), this.revision(this.selection.pending)) })
  }
  dispose(): void { this.disposed = true }
}
