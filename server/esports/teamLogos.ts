import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { metadataUserAgent } from '../appIdentity'
import { metadataConfig } from '../config'
import { safeFetch, type Resolver } from '../safeFetch'
import { LiquipediaRateLimit } from './liquipediaRateLimit'

export const LOGO_TTL_MS = 7 * 24 * 60 * 60_000
export const LOGO_FAILURE_TTL_MS = 60 * 60_000
export const LOGO_MAX_BYTES = 200_000
export const LOGO_KEY = /^[a-z0-9]{1,64}$/
const FORMATS = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const
type Extension = keyof typeof FORMATS

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

/** The protocol reader never accepts a path from its caller, only a bounded hash key. */
export function readTeamLogo(root: string, key: string, now = Date.now()): { bytes: Buffer; type: string } | null {
  if (!LOGO_KEY.test(key)) return null
  const dir = directory(root)
  if (!dir) return null
  for (const ext of Object.keys(FORMATS) as Extension[]) {
    const file = join(dir, `${key}.${ext}`)
    try {
      const stat = lstatSync(file)
      // Filesystem timestamps can have finer precision than the millisecond wall clock.
      const modifiedAt = Math.floor(stat.mtimeMs)
      if (now < modifiedAt || now - modifiedAt >= LOGO_TTL_MS) continue
      const bytes = regularFile(file)
      if (bytes && logoFormat(bytes) === ext) return { bytes, type: FORMATS[ext] }
    } catch { /* Try the next supported extension. */ }
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

let active = 0
const waiters: Array<() => void> = []
async function slot<T>(run: () => Promise<T>): Promise<T> {
  if (active < 1) active++
  else await new Promise<void>(resolve => waiters.push(resolve))
  try { return await run() } finally { const next = waiters.shift(); if (next) next(); else active-- }
}

interface Dependencies {
  userDataDir: string
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
  constructor(private readonly options: Dependencies) {
    this.now = options.now ?? Date.now
    this.rateLimit = options.rateLimit ?? new LiquipediaRateLimit(options.userDataDir, this.now)
  }

  get(path: string | undefined, download = true): string | null {
    const normalized = normalizeLogoPath(path)
    if (!normalized || this.lifetime.signal.aborted) return null
    const key = teamLogoKey(normalized)
    if (readTeamLogo(this.options.userDataDir, key, this.now())) return `app://app/team-logo/${key}`
    if (download && !this.flights.has(key) && !this.failedRecently(key)) {
      const work = slot(() => this.download(normalized, key)).catch(() => {}).finally(() => this.flights.delete(key))
      this.flights.set(key, work)
    }
    return null
  }

  private failedRecently(key: string): boolean {
    const dir = directory(this.options.userDataDir)
    if (!dir) return false
    try {
      const bytes = regularFile(join(dir, `${key}.failed.json`), 100)
      if (!bytes) return false
      const at = (JSON.parse(bytes.toString('utf8')) as { at?: unknown }).at
      return typeof at === 'number' && Number.isSafeInteger(at) && at <= this.now() && this.now() - at < LOGO_FAILURE_TTL_MS
    } catch { return false }
  }

  private async download(path: string, key: string): Promise<void> {
    if (this.lifetime.signal.aborted || readTeamLogo(this.options.userDataDir, key, this.now()) || this.failedRecently(key)) return
    try {
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
      const { response, finalUrl } = await safeFetch(`https://liquipedia.net${path}`, metadataConfig(), {
        signal,
        resolve: this.options.resolve,
        fetchImpl: async (input, init) => {
          await this.rateLimit.wait(signal)
          signal.throwIfAborted()
          return (this.options.request ?? fetch)(input, init)
        },
        headers: { 'User-Agent': metadataUserAgent(this.options.version), Accept: 'image/png,image/jpeg,image/webp' },
      })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const size = response.headers.get('content-length')
      if (response.status !== 200 || response.redirected || finalUrl.origin !== 'https://liquipedia.net'
        || normalizeLogoPath(finalUrl.pathname) !== path || !response.body || !Object.values(FORMATS).some(value => value === type)
        || (size !== null && (!/^\d+$/.test(size) || Number(size) > LOGO_MAX_BYTES))) {
        await response.body?.cancel().catch(() => {})
        throw new Error('Invalid team logo response')
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          length += part.value.byteLength
          if (length > LOGO_MAX_BYTES) throw new Error('Team logo too large')
          chunks.push(part.value)
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
      const bytes = Buffer.concat(chunks), ext = logoFormat(bytes)
      if (!ext || FORMATS[ext] !== type) throw new Error('Invalid team logo signature')
      this.lifetime.signal.throwIfAborted()
      const dir = directory(this.options.userDataDir, true)
      if (!dir) throw new Error('Invalid team logo directory')
      atomicFile(dir, `${key}.${ext}`, bytes)
      try { unlinkSync(join(dir, `${key}.failed.json`)) } catch { /* No prior failure. */ }
      try { this.options.onUpdated?.() } catch { /* Notification failures cannot invalidate the image. */ }
    } catch {
      if (this.lifetime.signal.aborted) return
      try { const dir = directory(this.options.userDataDir, true); if (dir) atomicFile(dir, `${key}.failed.json`, JSON.stringify({ at: this.now() })) } catch { /* Cache failures cannot reject the schedule. */ }
    }
  }

  async idle(): Promise<void> { await Promise.allSettled(this.flights.values()) }
  async dispose(): Promise<void> { this.lifetime.abort(); await this.idle() }
}
