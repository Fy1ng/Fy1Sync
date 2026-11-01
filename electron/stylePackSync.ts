import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { parseHudStylePack } from '../src/core/hudStylePack'
import { etagFor, fileNameFor, MAX_PRESET_BYTES, type PresetRecord } from '../server/presetStore'
import { safeFetch, type Resolver } from '../server/safeFetch'
import { compareAppVersions } from './appUpdateService'
import { assertRegularPath, containedPath, privateDirectory } from './privateStorage'
import type { SignedStylePackCatalog, StylePackCatalog, StylePackCatalogEntry, StylePackMirror, StylePackSource, StylePackSourceId, StylePackSyncEvent, StylePackSyncState } from './stylePackSyncContracts'

const MAX_CATALOG_BYTES = 256 * 1024
const MAX_ARCHIVE_BYTES = 72 * 1024 * 1024
const MAX_PROOFS = 4096
const START_DELAY = 10_000
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const RETRY_DELAY = 15 * 60 * 1000
const REQUEST_TIMEOUT = 20_000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const invalid = () => new Error('样式包来源或签名清单无效.')
const SOURCE_LABEL = { github: 'GitHub', gitcode: 'GitCode' } as const

function base64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid()
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw invalid()
  return bytes
}

export function parseStylePackSource(raw: unknown): StylePackSource | null {
  if (raw === null || raw === undefined) return null
  if (!object(raw) || !exact(raw, ['mirrors', 'publicKey']) || !Array.isArray(raw.mirrors) || !raw.mirrors.length || raw.mirrors.length > 2) throw invalid()
  const ids = new Set<string>()
  const mirrors: StylePackMirror[] = raw.mirrors.map(value => {
    if (!object(value) || !exact(value, ['id', 'manifestUrl']) || (value.id !== 'github' && value.id !== 'gitcode') || ids.has(value.id)
      || typeof value.manifestUrl !== 'string' || value.manifestUrl.length > 2048 || /[\x00-\x20\x7f]/.test(value.manifestUrl)) throw invalid()
    let url: URL
    try { url = new URL(value.manifestUrl) } catch { throw invalid() }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search || !url.hostname.includes('.')) throw invalid()
    ids.add(value.id)
    return { id: value.id, manifestUrl: url.href }
  })
  if (typeof raw.publicKey !== 'string' || raw.publicKey.length > 128) throw invalid()
  const key = base64(raw.publicKey)
  if (key.length !== 44) throw invalid()
  try {
    const publicKey = createPublicKey({ key, type: 'spki', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'ed25519' || !Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).equals(key)) throw invalid()
  } catch { throw invalid() }
  return { mirrors, publicKey: key.toString('base64') }
}

function semver(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value)) return false
  try { compareAppVersions(value, value); return true } catch { return false }
}

/** Authenticate exact payload bytes before interpreting any catalog field. */
export function verifyStylePackCatalog(raw: unknown, source: StylePackSource): StylePackCatalog {
  const configured = parseStylePackSource(source)!
  if (!object(raw) || !exact(raw, ['payload', 'signature']) || Buffer.byteLength(JSON.stringify(raw)) > MAX_CATALOG_BYTES) throw invalid()
  const payload = base64(raw.payload), signature = base64(raw.signature)
  if (signature.length !== 64 || !verify(null, payload, createPublicKey({ key: Buffer.from(configured.publicKey, 'base64'), format: 'der', type: 'spki' }), signature)) throw invalid()
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) } catch { throw invalid() }
  if (!object(value) || !exact(value, ['kind', 'schemaVersion', 'revision', 'packs']) || value.kind !== 'fy1sync-stylepack-catalog' || value.schemaVersion !== 1 || !positive(value.revision) || !Array.isArray(value.packs) || value.packs.length > 128) throw invalid()
  const ids = new Set<string>()
  const packs: StylePackCatalogEntry[] = value.packs.map((entry: unknown) => {
    if (!object(entry) || !exact(entry, ['id', 'revision', 'sha256', 'bytes', 'path', 'minAppVersion']) || typeof entry.id !== 'string' || !fileNameFor(entry.id) || ids.has(entry.id) || !positive(entry.revision) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !positive(entry.bytes) || entry.bytes > MAX_PRESET_BYTES || entry.path !== `packs/${entry.sha256}.json` || !semver(entry.minAppVersion)) throw invalid()
    ids.add(entry.id)
    return { id: entry.id, revision: entry.revision, sha256: entry.sha256, bytes: entry.bytes, path: entry.path as string, minAppVersion: entry.minAppVersion }
  })
  return { kind: 'fy1sync-stylepack-catalog', schemaVersion: 1, revision: value.revision, packs }
}

interface Proof { envelope: SignedStylePackCatalog; catalog: StylePackCatalog; hash: string }
interface Installed { entry: StylePackCatalogEntry; proof: Proof; record: PresetRecord }
interface Options { dataDir: string; source: StylePackSource | null; currentVersion: string; request?: typeof fetch; resolve?: Resolver; now?: () => number }

/** Bound injected transports and streamed reads even when they ignore AbortSignal. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((yes, no) => {
    const abort = () => { signal.removeEventListener('abort', abort); no(new Error('样式包同步已取消.')) }
    if (signal.aborted) { void operation.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else yes(value) }, error => { signal.removeEventListener('abort', abort); no(error) })
  })
}

async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (!response.ok || response.redirected || (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))) { void response.body?.cancel().catch(() => {}); throw invalid() }
  if (!response.body) throw invalid()
  const reader = response.body.getReader(), chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await bounded(reader.read(), signal)
      if (next.done) break
      bytes += next.value.length
      if (bytes > limit) throw invalid()
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks, bytes)
  } finally { void reader.cancel().catch(() => {}) }
}

export class StylePackSyncService {
  private readonly source: StylePackSource | null
  private readonly now: () => number
  private readonly listeners = new Set<(event: StylePackSyncEvent) => void>()
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private disposed = false
  private failures = 0
  private flight: Promise<StylePackSyncState> | null = null
  private proofs: Proof[] = []
  private installed = new Map<string, Installed>()
  private value: StylePackSyncState

  constructor(private readonly options: Options) {
    this.source = parseStylePackSource(options.source)
    this.now = options.now ?? Date.now
    if (!semver(options.currentVersion)) throw new Error('应用版本号无效.')
    const availableSources = this.source?.mirrors.map(mirror => mirror.id) ?? []
    let selected: StylePackSourceId = availableSources.includes('github') ? 'github' : availableSources[0] ?? 'github'
    try {
      const preference: unknown = JSON.parse(this.bytes('source.json', 1024).toString('utf8'))
      if (object(preference) && exact(preference, ['source']) && availableSources.includes(preference.source as StylePackSourceId)) selected = preference.source as StylePackSourceId
    } catch { /* An absent or invalid local preference cannot change the trusted mirror list. */ }
    this.value = { source: selected, availableSources, catalogRevision: null, phase: this.source ? 'idle' : 'unconfigured', checkedAt: null, updatedAt: null,
      installed: 0, downloaded: 0, incompatible: 0, message: this.source ? '赛事样式将在后台自动同步.' : '尚未配置赛事样式来源.' }
    if (this.source) this.load()
  }

  state(): StylePackSyncState { return { ...this.value, availableSources: [...this.value.availableSources] } }
  setSource(id: StylePackSourceId): StylePackSyncState {
    if (!this.source?.mirrors.some(mirror => mirror.id === id)) throw new Error('该样式包来源未配置.')
    if (this.disposed || this.flight || this.value.phase === 'syncing') throw new Error('正在刷新样式包, 请完成后再切换来源.')
    if (id === this.value.source) return this.state()
    this.atomic('source.json', Buffer.from(JSON.stringify({ source: id })))
    this.failures = 0
    this.update({ source: id, phase: 'idle', checkedAt: null, downloaded: 0, message: `已选择 ${SOURCE_LABEL[id]}, 点击手动刷新从该源检查更新.` })
    this.schedule(CHECK_INTERVAL)
    return this.state()
  }
  async list(): Promise<PresetRecord[]> { return structuredClone([...this.installed.values()].map(value => value.record)) }
  async get(id: string): Promise<PresetRecord | null> { return structuredClone(this.installed.get(id)?.record ?? null) }
  subscribe(listener: (event: StylePackSyncEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(event: StylePackSyncEvent): void { for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { /* Observers cannot invalidate an installed snapshot. */ } } }
  private update(value: Partial<StylePackSyncState>): void { this.value = { ...this.value, ...value }; if (!this.disposed) this.emit({ topic: 'stylepacks-state', data: this.state() }) }

  start(): void { if (this.started || this.disposed || !this.source) return; this.started = true; this.schedule(START_DELAY) }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started || this.disposed || !this.source) return
    this.timer = setTimeout(() => { this.timer = null; void this.sync() }, delay)
    this.timer.unref?.()
  }

  sync(): Promise<StylePackSyncState> {
    if (this.disposed || !this.source) return Promise.resolve(this.state())
    if (this.flight) return this.flight
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.flight = this.run().finally(() => {
      this.flight = null
      this.schedule(this.failures ? Math.min(CHECK_INTERVAL, RETRY_DELAY * 2 ** Math.min(8, this.failures - 1)) : CHECK_INTERVAL)
    })
    return this.flight
  }

  private latest(proofs = this.proofs): Proof | undefined { return proofs.at(-1) }
  private proof(raw: unknown): Proof {
    const catalog = verifyStylePackCatalog(raw, this.source!)
    const envelope = structuredClone(raw as SignedStylePackCatalog)
    return { envelope, catalog, hash: digest(Buffer.from(envelope.payload, 'base64')) }
  }
  private histories(proofs: Proof[]): Map<string, { entry: StylePackCatalogEntry; proof: Proof }> {
    const seen = new Map<string, { entry: StylePackCatalogEntry; proof: Proof }>()
    for (const proof of proofs) for (const entry of proof.catalog.packs) {
      const previous = seen.get(entry.id)
      if (previous && (entry.revision < previous.entry.revision || entry.revision === previous.entry.revision && JSON.stringify(entry) !== JSON.stringify(previous.entry))) throw invalid()
      seen.set(entry.id, { entry, proof })
    }
    return seen
  }
  private selected(proofs: Proof[], appVersion = this.options.currentVersion): Map<string, { entry: StylePackCatalogEntry; proof: Proof }> {
    const current = this.latest(proofs)
    const ids = new Set(current?.catalog.packs.map(entry => entry.id))
    const selected = new Map<string, { entry: StylePackCatalogEntry; proof: Proof }>()
    for (const proof of proofs) for (const entry of proof.catalog.packs) if (ids.has(entry.id) && compareAppVersions(appVersion, entry.minAppVersion) >= 0) selected.set(entry.id, { entry, proof })
    return selected
  }
  private file(relative: string): string { return containedPath(this.options.dataDir, path.join(this.options.dataDir, 'stylepacks', relative)) }
  private bytes(relative: string, max: number): Buffer {
    const file = this.file(relative)
    assertRegularPath(file, false)
    const size = fs.statSync(file).size
    if (size > max) throw invalid()
    return fs.readFileSync(file)
  }
  private record(entry: StylePackCatalogEntry, bytes: Buffer, updatedAt: number): PresetRecord {
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw invalid()
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
    const parsed = parseHudStylePack(raw)
    if (!parsed.pack || parsed.pack.id !== entry.id || parsed.pack.revision !== entry.revision) throw invalid()
    return { id: entry.id, profile: parsed.pack, updatedAt, etag: etagFor(parsed.pack) }
  }
  private load(): void {
    try {
      const archive: unknown = JSON.parse(this.bytes('active.json', MAX_ARCHIVE_BYTES).toString('utf8'))
      if (!object(archive) || !exact(archive, ['schemaVersion', 'appVersion', 'catalogs']) || archive.schemaVersion !== 1 || !semver(archive.appVersion) || !Array.isArray(archive.catalogs) || archive.catalogs.length === 0 || archive.catalogs.length > MAX_PROOFS) throw invalid()
      const proofs = archive.catalogs.map(raw => this.proof(raw))
      for (let index = 1; index < proofs.length; index++) if (proofs[index]!.catalog.revision <= proofs[index - 1]!.catalog.revision) throw invalid()
      this.histories(proofs)
      // Keep authenticated revision evidence even when a blob needs repair.
      this.proofs = proofs
      const updatedAt = fs.statSync(this.file('active.json')).mtimeMs
      const installed = new Map<string, Installed>()
      // An incomplete on-disk snapshot is never exposed as a partially updated catalog.
      // An application upgrade must not replace a cached compatible pack with a newer
      // version that the previous client deliberately skipped and never downloaded.
      const cachedVersion = compareAppVersions(this.options.currentVersion, archive.appVersion) < 0 ? this.options.currentVersion : archive.appVersion
      for (const [id, item] of this.selected(proofs, cachedVersion)) installed.set(id, { ...item, record: this.record(item.entry, this.bytes(item.entry.path, MAX_PRESET_BYTES), updatedAt) })
      this.proofs = proofs
      this.installed = installed
      this.value = { ...this.value, catalogRevision: this.latest()!.catalog.revision, installed: installed.size, updatedAt, incompatible: this.latest()!.catalog.packs.filter(entry => compareAppVersions(this.options.currentVersion, entry.minAppVersion) < 0).length }
    } catch { /* Missing or damaged cloud data never touches local user presets. */ }
  }

  private atomic(relative: string, bytes: Buffer): void {
    this.lifetime.signal.throwIfAborted()
    const target = this.file(relative)
    const directory = privateDirectory(this.options.dataDir, path.dirname(target))
    if (fs.existsSync(target)) assertRegularPath(target, false)
    const temporary = this.file(path.relative(path.join(this.options.dataDir, 'stylepacks'), path.join(directory, `.${path.basename(target)}-${randomUUID()}.tmp`)))
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      this.lifetime.signal.throwIfAborted()
      containedPath(this.options.dataDir, target)
      assertRegularPath(temporary, false)
      fs.renameSync(temporary, target)
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      containedPath(this.options.dataDir, temporary)
      fs.rmSync(temporary, { force: true })
    }
  }

  private async download(mirror: StylePackMirror, url: string, limit: number): Promise<Buffer> {
    const manifest = new URL(mirror.manifestUrl), target = new URL(url)
    if (target.origin !== manifest.origin || !target.pathname.startsWith(new URL('.', manifest).pathname) || target.search || target.hash || target.username || target.password) throw invalid()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT)
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal])
    try {
      const request: typeof fetch = (input, init) => bounded((this.options.request ?? fetch)(input, { ...init, credentials: 'omit', cache: 'no-store' }), signal)
      const result = await bounded(safeFetch(target.href, { enabled: true, hosts: [target.hostname], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: REQUEST_TIMEOUT },
        { signal, resolve: this.options.resolve, fetchImpl: request, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } }), signal)
      if (result.finalUrl.href !== target.href) throw invalid()
      if (!result.response.ok) { void result.response.body?.cancel().catch(() => {}); throw new Error(`来源返回 HTTP ${result.response.status}.`) }
      return await readBounded(result.response, limit, signal)
    } finally { clearTimeout(timer) }
  }

  private removeUnusedBlobs(installed: Map<string, Installed>): void {
    try {
      const directory = this.file('packs')
      assertRegularPath(directory, true)
      const keep = new Set([...installed.values()].map(item => path.basename(item.entry.path)))
      for (const name of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name) || keep.has(name)) continue
        const file = this.file(`packs/${name}`)
        assertRegularPath(file, false)
        fs.unlinkSync(file)
      }
    } catch { /* A cleanup failure cannot invalidate the committed snapshot. */ }
  }

  private async run(): Promise<StylePackSyncState> {
    const mirror = this.source!.mirrors.find(item => item.id === this.value.source)!
    const label = SOURCE_LABEL[mirror.id]
    this.update({ phase: 'syncing', downloaded: 0, message: `正在从 ${label} 刷新赛事样式.` })
    let downloaded = 0
    try {
      const bytes = await this.download(mirror, mirror.manifestUrl, MAX_CATALOG_BYTES)
      const incoming = this.proof(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      const previous = this.latest()
      if (previous && (incoming.catalog.revision < previous.catalog.revision || incoming.catalog.revision === previous.catalog.revision && incoming.hash !== previous.hash)) throw invalid()
      const candidates = previous?.hash === incoming.hash ? [...this.proofs] : [...this.proofs, incoming]
      const history = this.histories(candidates)
      const selection = this.selected(candidates)
      const installed = new Map<string, Installed>()
      for (const [id, item] of selection) {
        let record: PresetRecord | null = null
        try { record = this.record(item.entry, this.bytes(item.entry.path, MAX_PRESET_BYTES), this.now()) } catch { /* Download verified bytes to repair absent or damaged cache entries. */ }
        if (!record) {
          const blob = await this.download(mirror, new URL(item.entry.path, mirror.manifestUrl).href, item.entry.bytes)
          record = this.record(item.entry, blob, this.now())
          this.lifetime.signal.throwIfAborted()
          this.atomic(item.entry.path, blob)
          downloaded++
        }
        installed.set(id, { ...item, record })
      }
      const required = new Set([incoming.hash, ...[...history.values()].map(item => item.proof.hash), ...[...installed.values()].map(item => item.proof.hash)])
      const proofs = candidates.filter(item => required.has(item.hash))
      if (proofs.length > MAX_PROOFS) throw invalid()
      const archive = Buffer.from(JSON.stringify({ schemaVersion: 1, appVersion: this.options.currentVersion, catalogs: proofs.map(item => item.envelope) }))
      if (archive.length > MAX_ARCHIVE_BYTES) throw invalid()
      const identity = (items: Map<string, Installed>) => JSON.stringify([...items.values()].map(item => [item.entry.id, item.entry.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!)))
      const changed = identity(installed) !== identity(this.installed)
      this.lifetime.signal.throwIfAborted()
      this.atomic('active.json', archive)
      this.proofs = proofs
      this.installed = installed
      this.removeUnusedBlobs(installed)
      this.failures = 0
      const at = this.now()
      this.update({ phase: changed ? 'updated' : 'current', catalogRevision: incoming.catalog.revision, installed: installed.size, checkedAt: at, updatedAt: changed ? at : this.value.updatedAt, downloaded,
        incompatible: incoming.catalog.packs.filter(entry => compareAppVersions(this.options.currentVersion, entry.minAppVersion) < 0).length,
        message: changed ? `已从 ${label} 更新赛事样式.` : `${label} 的赛事样式已是最新可用版本.` })
      if (changed && !this.disposed) this.emit({ topic: 'stylepacks-changed', data: { revision: incoming.catalog.revision } })
    } catch (error) {
      const detail = error instanceof Error && /^来源返回 HTTP \d{3}\.$/.test(error.message) ? ` ${error.message}` : ''
      if (!this.disposed) { this.failures++; this.update({ phase: 'error', checkedAt: this.now(), downloaded,
        message: `${label} 刷新失败.${detail} 已保留原有可用样式, 可重试或手动切换来源.` }) }
    }
    return this.state()
  }

  dispose(): void { if (this.disposed) return; this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; this.lifetime.abort(); this.listeners.clear() }
}
