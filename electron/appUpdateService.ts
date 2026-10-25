import { checkUrl, safeFetch, type Resolver } from '../server/safeFetch'
import type { ProxyConfig } from '../server/config'

export type AppUpdateSource =
  | { kind: 'manifest'; manifestUrl: string; releaseOrigin?: string }
  | { kind: 'github'; owner: string; repository: string }
export interface AppUpdateState {
  phase: 'unconfigured' | 'idle' | 'checking' | 'current' | 'available' | 'error'
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  releaseNotes: string | null
  checkedAt: number | null
  message: string
}
type ParsedVersion = { numbers: number[]; prerelease: string[] }
const MAX_JSON = 256 * 1024
const TIMEOUT = 15_000

function version(value: unknown): ParsedVersion | null {
  if (typeof value !== 'string' || value.length > 128) return null
  const match = /^v?(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(item => /^0[0-9]+$/.test(item))) return null
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease }
}

/** SemVer precedence, including numeric prerelease identifiers and ignored build metadata. */
export function compareAppVersions(left: string, right: string): -1 | 0 | 1 {
  const a = version(left), b = version(right)
  if (!a || !b) throw new Error('应用版本号无效.')
  for (let index = 0; index < 3; index++) if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! < b.numbers[index]! ? -1 : 1
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^[0-9]+$/.test(x), numericY = /^[0-9]+$/.test(y)
    if (numericX !== numericY) return numericX ? -1 : 1
    if (numericX && x.length !== y.length) return x.length < y.length ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

function https(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2_048 || /[\x00-\x20\x7f]/.test(value)) throw new Error('更新来源配置无效.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('更新来源配置无效.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !url.hostname.includes('.')) throw new Error('更新来源配置无效.')
  return url
}

export function parseAppUpdateSource(raw: unknown): AppUpdateSource | null {
  if (raw === null || raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('更新来源配置无效.')
  const source = raw as Record<string, unknown>
  if (source.kind === 'github') {
    if (Object.keys(source).some(key => !['kind', 'owner', 'repository'].includes(key)) ||
        typeof source.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(source.owner) ||
        typeof source.repository !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(source.repository)) throw new Error('更新来源配置无效.')
    return { kind: 'github', owner: source.owner, repository: source.repository }
  }
  if (source.kind === 'manifest') {
    if (Object.keys(source).some(key => !['kind', 'manifestUrl', 'releaseOrigin'].includes(key))) throw new Error('更新来源配置无效.')
    const manifest = https(source.manifestUrl)
    let releaseOrigin: string | undefined
    if (source.releaseOrigin !== undefined) {
      const release = https(source.releaseOrigin)
      if (release.pathname !== '/' || release.search) throw new Error('更新发布站点配置无效.')
      releaseOrigin = release.origin
    }
    return { kind: 'manifest', manifestUrl: manifest.href, ...(releaseOrigin ? { releaseOrigin } : {}) }
  }
  throw new Error('更新来源配置无效.')
}

function policy(host: string): ProxyConfig {
  return { enabled: true, hosts: [host], allowNonStandardPorts: false, allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: TIMEOUT }
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('更新检查已取消.')) }
    if (signal.aborted) { void promise.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_JSON)) { void response.body?.cancel(); throw new Error('Invalid release response') }
  if (!response.body) throw new Error('Missing release response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0, reads = 0
  try {
    for (;;) {
      const next = await bounded(reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_JSON || ++reads > 65_536) throw new Error('Large release response')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Reads release metadata only. It has no file-writing, download or installation capability. */
export class AppUpdateService {
  private readonly source: AppUpdateSource | null
  private readonly currentVersion: string
  private status: AppUpdateState
  private flight?: Promise<AppUpdateState>
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(private readonly options: { currentVersion: string; source: AppUpdateSource | null; request?: typeof fetch; resolve?: Resolver; now?: () => number }) {
    if (!version(options.currentVersion)) throw new Error('应用版本号无效.')
    this.currentVersion = options.currentVersion
    this.source = parseAppUpdateSource(options.source)
    this.status = { phase: this.source ? 'idle' : 'unconfigured', currentVersion: this.currentVersion,
      latestVersion: null, releaseUrl: null, releaseNotes: null, checkedAt: null,
      message: this.source ? '手动检查应用版本更新.' : '尚未配置本应用的可信发布源.' }
  }
  state(): AppUpdateState { return { ...this.status } }
  check(): Promise<AppUpdateState> {
    if (this.disposed) return Promise.resolve({ ...this.state(), phase: 'error', message: '应用更新服务已关闭.' })
    if (!this.source) return Promise.resolve(this.state())
    if (this.flight) return this.flight
    this.status = { ...this.status, phase: 'checking', latestVersion: null, releaseUrl: null, releaseNotes: null, message: '正在检查应用版本.' }
    const flight = this.run(this.source).finally(() => { if (this.flight === flight) this.flight = undefined })
    this.flight = flight
    return flight
  }

  private async run(source: AppUpdateSource): Promise<AppUpdateState> {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), TIMEOUT)
    const signal = AbortSignal.any([timeout.signal, this.lifetime.signal])
    const now = () => {
      const value = (this.options.now ?? Date.now)()
      return Number.isSafeInteger(value) && value >= 0 ? value : Date.now()
    }
    try {
      const url = source.kind === 'manifest' ? new URL(source.manifestUrl)
        : new URL(`https://api.github.com/repos/${source.owner}/${source.repository}/releases/latest`)
      const { response } = await safeFetch(url.href, policy(url.hostname), {
        signal, resolve: this.options.resolve,
        fetchImpl: async (input, init) => {
          const result = await bounded((this.options.request ?? fetch)(input, { ...init,
            headers: { Accept: 'application/json', 'User-Agent': 'Stream-Syncer-Version-Check' },
          }).then(result => { if (signal.aborted) { void result.body?.cancel(); throw new Error('Cancelled') }; return result }), signal)
          if (result.status !== 200 || result.redirected || (result.url && result.url !== url.href)) { void result.body?.cancel(); throw new Error('Unexpected release response') }
          return result
        },
      })
      const raw = await readJson(response, signal)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid release')
      const release = raw as Record<string, unknown>
      const latestVersion = source.kind === 'manifest' ? release.version : release.tag_name
      if (typeof latestVersion !== 'string' || !version(latestVersion)) throw new Error('Invalid release version')
      if (source.kind === 'github' && (release.draft !== false || release.prerelease !== false)) throw new Error('Not a stable release')
      const releaseUrl = https(source.kind === 'manifest' ? release.releaseUrl : release.html_url)
      if (releaseUrl.search) throw new Error('Invalid release URL')
      if (source.kind === 'manifest') {
        if (releaseUrl.origin !== (source.releaseOrigin ?? url.origin)) throw new Error('Release origin mismatch')
      } else if (releaseUrl.origin !== 'https://github.com' || releaseUrl.pathname !== `/${source.owner}/${source.repository}/releases/tag/${encodeURIComponent(latestVersion)}`) throw new Error('Release repository mismatch')
      const destination = await bounded(checkUrl(releaseUrl.href, policy(releaseUrl.hostname), this.options.resolve), signal)
      if (!destination.ok || signal.aborted) throw new Error('Unsafe release URL')
      const notes = source.kind === 'manifest' ? release.notes : release.body
      if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 65_536)) throw new Error('Invalid release notes')
      const available = compareAppVersions(latestVersion, this.currentVersion) > 0
      this.status = { phase: available ? 'available' : 'current', currentVersion: this.currentVersion, latestVersion,
        releaseUrl: releaseUrl.href, releaseNotes: typeof notes === 'string' ? notes.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, 8_192) : null,
        checkedAt: now(), message: available ? '发现新的应用版本, 可查看发布页.' : '未发现比当前版本更新的发布版本.' }
    } catch {
      this.status = { phase: 'error', currentVersion: this.currentVersion, latestVersion: null, releaseUrl: null,
        releaseNotes: null, checkedAt: now(), message: this.disposed ? '应用更新服务已关闭.' : '应用更新检查失败或发布信息无法确认, 请稍后重试.' }
    } finally { clearTimeout(timer) }
    return this.state()
  }
  dispose(): void { this.disposed = true; this.lifetime.abort() }
}
