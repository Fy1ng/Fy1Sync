import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { ProxyError, safeFetch, type Resolver } from '../safeFetch'
import { LiquipediaRateLimit } from './liquipediaRateLimit'

export const LOGO_REFRESH_MS = 7 * 24 * 60 * 60_000
export const LOGO_REFRESH_STEP_MS = 30_000
export const LOGO_FAILURE_TTL_MS = 60 * 60_000
export const LOGO_RETRY_DELAYS_MS = [5_000, 30_000] as const
export const LOGO_RETRY_COOLDOWN_MS = 5 * 60_000
export const LOGO_MAX_BYTES = 200_000
export const LOGO_KEY = /^[a-z0-9]{1,64}$/
const FORMATS = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const
type Extension = keyof typeof FORMATS
interface Logo { bytes: Buffer; type: string; sha256: string }
interface Checked { checkedAt: number; sha256: string; extension: Extension }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Accept relative commons paths only, before URL normalization can hide traversal. */
export function normalizeLogoPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2_000 || !raw.startsWith('/commons/images/')
    || /[\x00-\x20\x7f\\?#]/.test(raw)) return null
  try {
    const parts = raw.slice('/commons/images/'.length).split('/').map(part => decodeURIComponent(part))
    if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f\\/?#%]/.test(part))) return null
    const url = new URL(raw, 'https://liquipedia.net')
    return url.origin === 'https://liquipedia.net' && !url.search && !url.hash && url.pathname.startsWith('/commons/images/') ? url.pathname : null
  } catch { return null }
}

export function teamLogoKey(path: string): string { return createHash('sha256').update(path).digest('hex') }

export function logoFormat(bytes: Uint8Array): Extension | null {
  const value = Buffer.from(bytes)
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (value.length >= 3 && value[0] === 255 && value[1] === 216 && value[2] === 255) return 'jpg'
  if (value.length >= 12 && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  return null
}

function directory(root: string, create = false): string | null {
  let current = resolve(root)
  for (const part of ['', 'events', 'logos']) {
    if (part) current = join(current, part)
    try {
      if (create) { try { mkdirSync(current, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } }
      const stat = lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    } catch { return null }
  }
  return current
}

function regularFile(file: string, maxSize = LOGO_MAX_BYTES): Buffer | null {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSize) return null
    const bytes = readFileSync(file)
    return bytes.length <= maxSize ? bytes : null
  } catch { return null }
}

function checked(dir: string, key: string): Checked | null {
  try {
    const bytes = regularFile(join(dir, `${key}.checked.json`), 1_000)
    if (!bytes) return null
    const value = JSON.parse(bytes.toString('utf8')) as Checked
    return Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0 && /^[a-f0-9]{64}$/.test(value.sha256)
      && Object.hasOwn(FORMATS, value.extension) ? value : null
  } catch { return null }
}

/** Disk images have no expiration; timestamps only control background checks. */
export function readTeamLogo(root: string, key: string, _now = Date.now(), bundledLogoDir?: string): Logo | null {
  if (!LOGO_KEY.test(key)) return null
  for (const source of [root, bundledLogoDir]) {
    if (!source) continue
    const dir = directory(source)
    if (!dir) continue
    const preferred = checked(dir, key)?.extension
    const extensions = [...new Set([preferred, ...Object.keys(FORMATS)])].filter((ext): ext is Extension => !!ext)
    for (const ext of extensions) {
      const bytes = regularFile(join(dir, `${key}.${ext}`))
      if (bytes && logoFormat(bytes) === ext) return { bytes, type: FORMATS[ext], sha256: hash(bytes) }
    }
  }
  return null
}

function atomicFile(dir: string, name: string, bytes: Uint8Array | string): void {
  const temporary = join(dir, `${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(dir, name))
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed. */ } }
}

let active = false
const foreground: Array<() => void> = [], background: Array<() => void> = []
async function slot<T>(low: boolean, run: () => Promise<T>): Promise<T> {
  if (active) await new Promise<void>(yes => (low ? background : foreground).push(yes))
  else active = true
  try { return await run() }
  finally { const next = foreground.shift() ?? background.shift(); if (next) next(); else active = false }
}
class YieldRefresh extends Error {}
class InvalidLogo extends Error {}
class TemporaryLogo extends Error { constructor(readonly retryAfter = 0) { super('Temporary team logo failure') } }
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((yes, no) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); no(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); yes() }, Math.min(ms, 2_147_483_647))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort = () => {}
  try {
    return await Promise.race([work, new Promise<never>((_yes, no) => {
      abort = () => no(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

interface Dependencies {
  userDataDir: string
  bundledLogoDir?: string
  version: string
  request?: typeof fetch
  resolve?: Resolver
  now?: () => number
  rateLimit?: LiquipediaRateLimit
  onUpdated?: () => void
}

export class TeamLogoCache {
  private readonly now: () => number
  private readonly lifetime = new AbortController()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly rateLimit: LiquipediaRateLimit
  private activePaths = new Set<string>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshFlight = false
  constructor(private readonly options: Dependencies) {
    this.now = options.now ?? Date.now
    this.rateLimit = options.rateLimit ?? new LiquipediaRateLimit(options.userDataDir, this.now)
  }

  private read(key: string): Logo | null { return readTeamLogo(this.options.userDataDir, key, this.now(), this.options.bundledLogoDir) }
  get(path: string | undefined, download = true): string | null {
    const normalized = normalizeLogoPath(path)
    if (!normalized || this.lifetime.signal.aborted) return null
    const key = teamLogoKey(normalized), logo = this.read(key)
    if (logo) return `app://app/team-logo/${key}?v=${logo.sha256}`
    if (download) this.queue(normalized, false)
    return null
  }

  /** Build tooling can await one validated image without enabling periodic refresh. */
  async ensure(path: string): Promise<void> {
    this.get(path)
    const normalized = normalizeLogoPath(path)
    if (normalized) await this.flights.get(teamLogoKey(normalized))
  }

  setActivePaths(paths: Iterable<string>): void {
    this.activePaths = new Set([...paths].map(normalizeLogoPath).filter((path): path is string => !!path))
    if (this.activePaths.size && !this.refreshTimer && !this.lifetime.signal.aborted) this.scheduleRefresh()
    if (!this.activePaths.size) { clearTimeout(this.refreshTimer); this.refreshTimer = undefined }
  }

  private scheduleRefresh(): void {
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      if (this.lifetime.signal.aborted) return
      if (!this.refreshFlight) {
        for (const path of this.activePaths) {
          const key = teamLogoKey(path), logo = this.read(key)
          if (!logo || this.flights.has(key) || this.failedRecently(key)) continue
          const dir = directory(this.options.userDataDir), state = dir ? checked(dir, key) : null
          if (state && state.sha256 === logo.sha256 && state.checkedAt <= this.now() && this.now() - state.checkedAt < LOGO_REFRESH_MS) continue
          this.queue(path, true)
          break
        }
      }
      if (this.activePaths.size) this.scheduleRefresh()
    }, LOGO_REFRESH_STEP_MS)
    this.refreshTimer.unref?.()
  }

  private queue(path: string, low: boolean): void {
    const key = teamLogoKey(path)
    if (this.lifetime.signal.aborted || this.flights.has(key) || this.failedRecently(key)) return
    if (low) this.refreshFlight = true
    const work = this.download(path, key, low).catch(() => {}).finally(() => {
      this.flights.delete(key)
      if (low) this.refreshFlight = false
    })
    this.flights.set(key, work)
  }

  private failedRecently(key: string): boolean {
    const dir = directory(this.options.userDataDir)
    if (!dir) return false
    try {
      const bytes = regularFile(join(dir, `${key}.failed.json`), 200)
      if (!bytes) return false
      const value = JSON.parse(bytes.toString('utf8')) as { at: number; retryAt: number }
      return Number.isSafeInteger(value.at) && Number.isSafeInteger(value.retryAt) && value.at <= this.now()
        && value.retryAt > this.now()
    } catch { return false }
  }

  private async download(path: string, key: string, low: boolean): Promise<void> {
    let attempt = 0
    while (!this.lifetime.signal.aborted) {
      if (low && !this.activePaths.has(path)) return
      try {
        await slot(low, async () => {
          if (this.lifetime.signal.aborted || (low && !this.activePaths.has(path))) return
          if (!low && this.read(key)) return
          const result = await this.fetchImage(path, low)
          this.lifetime.signal.throwIfAborted()
          const previous = this.read(key), sha256 = hash(result.bytes)
          const dir = directory(this.options.userDataDir, true)
          if (!dir) throw new InvalidLogo('Invalid team logo directory')
          if (previous?.sha256 !== sha256) atomicFile(dir, `${key}.${result.ext}`, result.bytes)
          atomicFile(dir, `${key}.checked.json`, JSON.stringify({ checkedAt: this.now(), sha256, extension: result.ext }))
          if (previous?.sha256 !== sha256) { try { this.options.onUpdated?.() } catch { /* Notification failures cannot invalidate the image. */ } }
        })
        return
      } catch (error) {
        if (this.lifetime.signal.aborted) return
        if (error instanceof YieldRefresh) { await pause(Math.max(25, this.rateLimit.delay()), this.lifetime.signal); continue }
        const transient = !(error instanceof InvalidLogo) && (!(error instanceof ProxyError) || error.reason === 'dns-failed' || error.reason === 'upstream-failed')
        if (transient && attempt < LOGO_RETRY_DELAYS_MS.length) {
          const delay = Math.max(LOGO_RETRY_DELAYS_MS[attempt++]!, error instanceof TemporaryLogo ? error.retryAfter : 0)
          await pause(delay, this.lifetime.signal)
          continue
        }
        try {
          const dir = directory(this.options.userDataDir, true)
          const delay = transient ? Math.max(LOGO_RETRY_COOLDOWN_MS, error instanceof TemporaryLogo ? error.retryAfter : 0) : LOGO_FAILURE_TTL_MS
          if (dir) atomicFile(dir, `${key}.failed.json`, JSON.stringify({ at: this.now(), retryAt: this.now() + delay }))
        } catch { /* Cache failures cannot reject the schedule. */ }
        return
      }
    }
  }

  private async fetchImage(path: string, low: boolean): Promise<{ bytes: Buffer; ext: Extension }> {
    const controller = new AbortController(), signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const { response, finalUrl } = await safeFetch(`https://liquipedia.net${path}`, metadataConfig(), {
        signal,
        resolve: this.options.resolve,
        fetchImpl: async (input, init) => {
          if (low) {
            // Refreshes yield the only image slot while waiting for HTTP quota.
            if (foreground.length || !this.activePaths.has(path) || !this.rateLimit.reserve()) throw new YieldRefresh()
          } else await this.rateLimit.wait(signal)
          signal.throwIfAborted()
          timer = setTimeout(() => controller.abort(new DOMException('Team logo request timed out', 'TimeoutError')), 15_000)
          return abortable((this.options.request ?? fetch)(input, init), signal)
        },
        headers: { 'User-Agent': metadataUserAgent(this.options.version), 'Accept-Encoding': 'gzip', Accept: 'image/png,image/jpeg,image/webp' },
      })
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {})
        const raw = response.headers.get('retry-after'), seconds = raw && /^\d+$/.test(raw) ? Number(raw) * 1_000 : 0
        const date = raw ? Date.parse(raw) - this.now() : 0
        throw new TemporaryLogo(Math.max(0, Number.isFinite(seconds) ? seconds : 0, Number.isFinite(date) ? date : 0))
      }
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const size = response.headers.get('content-length')
      if (response.status !== 200 || response.redirected || finalUrl.origin !== 'https://liquipedia.net'
        || normalizeLogoPath(finalUrl.pathname) !== path || !response.body || !Object.values(FORMATS).some(value => value === type)
        || (size !== null && (!/^\d+$/.test(size) || Number(size) > LOGO_MAX_BYTES))) {
        await response.body?.cancel().catch(() => {})
        throw new InvalidLogo('Invalid team logo response')
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const part = await abortable(reader.read(), signal)
          signal.throwIfAborted()
          if (part.done) break
          length += part.value.byteLength
          if (length > LOGO_MAX_BYTES) throw new InvalidLogo('Team logo too large')
          chunks.push(part.value)
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
      const bytes = Buffer.concat(chunks), ext = logoFormat(bytes)
      if (!ext || FORMATS[ext] !== type) throw new InvalidLogo('Invalid team logo signature')
      return { bytes, ext }
    } finally { clearTimeout(timer) }
  }

  async idle(): Promise<void> { await Promise.allSettled(this.flights.values()) }
  async dispose(): Promise<void> { clearTimeout(this.refreshTimer); this.lifetime.abort(); await this.idle() }
}
