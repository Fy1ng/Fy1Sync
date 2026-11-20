import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LIQUIPEDIA_INTERVAL_MS = 2_000
export const PARSE_INTERVAL_MS = 30_000
export const DEFAULT_COOLDOWN_MS = 15 * 60_000
export const MAX_COOLDOWN_BACKOFF_MS = 6 * 60 * 60_000
const HTTP_ATTEMPT = 'liquipedia-http-attempt.json'
const PARSE_ATTEMPT = 'liquipedia-attempt.json'

export interface LiquipediaCooldown { at: number; until: number; count: number; retryAfter?: string; retryAfterUntil?: number; id?: string }
export const cooldownRound = (value: LiquipediaCooldown): string => value.id ?? `${value.at}:${value.until}:${value.count}`
export function verificationNotBefore(value: LiquipediaCooldown): number {
  if (value.retryAfterUntil !== undefined) return value.retryAfterUntil
  if (value.retryAfter && retryAfterDelay(value.retryAfter, value.at) !== null) return value.until
  return value.at
}
export class VerificationRoundEnded extends Error {}
export class LiquipediaCoolingDown extends Error {
  readonly status = 429
  readonly code = 'liquipedia-rate-limited'
  constructor(readonly cooldown: LiquipediaCooldown) {
    super('Liquipedia requests are paused after an upstream rate limit')
    this.name = 'LiquipediaCoolingDown'
  }
}
interface RequestTimes { http: number | null; parse: number | null; cooldown: LiquipediaCooldown | null }

/** Accept Retry-After delta seconds and HTTP dates, including the server clock's Date offset. */
export function retryAfterDelay(raw: string | null, now: number, serverDate?: string | null): number | null {
  if (!raw || raw.length > 256) return null
  const value = raw.trim()
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.min(seconds * 1_000, 8_640_000_000_000_000 - now) : null
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null
  const date = Date.parse(value), origin = serverDate ? Date.parse(serverDate) : NaN
  return Number.isFinite(date) ? Math.max(0, date - (Number.isFinite(origin) ? origin : now)) : null
}

function cooldownValue(value: unknown): LiquipediaCooldown | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Liquipedia cooldown')
  const raw = value as Record<string, unknown>, at = timestamp(raw.at), until = timestamp(raw.until)
  if (until < at || !Number.isInteger(raw.count) || Number(raw.count) < 1 || Number(raw.count) > 16
    || (raw.retryAfter !== undefined && (typeof raw.retryAfter !== 'string' || raw.retryAfter.length > 256))) throw new Error('Invalid Liquipedia cooldown')
  const retryAfterUntil = raw.retryAfterUntil === undefined ? undefined : timestamp(raw.retryAfterUntil)
  if (retryAfterUntil !== undefined && retryAfterUntil > until) throw new Error('Invalid Liquipedia upstream deadline')
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !/^[a-f\d-]{36}$/.test(raw.id))) throw new Error('Invalid Liquipedia cooldown ID')
  return { at, until, count: Number(raw.count), ...(typeof raw.retryAfter === 'string' ? { retryAfter: raw.retryAfter } : {}),
    ...(retryAfterUntil === undefined ? {} : { retryAfterUntil }), ...(typeof raw.id === 'string' ? { id: raw.id } : {}) }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000) throw new Error('Invalid request reservation')
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request reservation')
    return value as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid request timestamp')
  return Number(value)
}

function atomicJson(directory: string, name: string, value: unknown): void {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, join(directory, name))
  } finally { try { unlinkSync(temporary) } catch { /* Already renamed. */ } }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, Math.min(ms, 2_147_483_647))
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Every actual Liquipedia dispatch reserves one durable HTTP slot under the same disk mutex. */
export class LiquipediaRateLimit {
  private readonly directory: string
  private localCooldown: LiquipediaCooldown | null = null
  private readonly pendingCooldowns = new Map<string, LiquipediaCooldown>()
  constructor(userDataDir: string, private readonly now: () => number = Date.now) {
    this.directory = join(resolve(userDataDir), 'events')
  }

  private timestamps(): RequestTimes {
    const http = readJson(join(this.directory, HTTP_ATTEMPT))
    const legacy = readJson(join(this.directory, PARSE_ATTEMPT))
    const parseTimes = [legacy ? timestamp(legacy.at) : null, http?.parseAt === undefined ? null : timestamp(http.parseAt)]
      .filter((value): value is number => value !== null)
    return { http: http ? timestamp(http.at) : null, parse: parseTimes.length ? Math.max(...parseTimes) : null,
      cooldown: cooldownValue(http?.cooldown) }
  }

  /** Shared by schedule, category lookups, channel lookups and images, including after restart. */
  cooldown(): LiquipediaCooldown | null {
    try { this.localCooldown = this.timestamps().cooldown } catch { /* Invalid reservations still refuse dispatch in reserve(). */ }
    const value = this.effectiveCooldown(this.localCooldown)
    return value && value.until > this.now() ? { ...value } : null
  }

  private effectiveCooldown(stored: LiquipediaCooldown | null): LiquipediaCooldown | null {
    let value = stored
    const now = this.now()
    for (const [id, pending] of this.pendingCooldowns) {
      if (pending.until <= now) this.pendingCooldowns.delete(id)
      else if (!value || pending.until >= value.until) value = pending
    }
    return value
  }

  throwIfCooling(): void {
    const cooldown = this.cooldown()
    if (cooldown) throw new LiquipediaCoolingDown(cooldown)
  }

  delay(parse = false): number {
    try {
      const now = timestamp(this.now()), last = this.timestamps()
      return Math.max(this.slotDelay(last, now, parse), (this.effectiveCooldown(last.cooldown)?.until ?? 0) - now)
    } catch { return parse ? PARSE_INTERVAL_MS : LIQUIPEDIA_INTERVAL_MS }
  }

  private slotDelay(last: RequestTimes, now: number, parse: boolean): number {
    const http = Math.max(last.http ?? -LIQUIPEDIA_INTERVAL_MS, last.parse ?? -LIQUIPEDIA_INTERVAL_MS)
    return Math.max(0, http + LIQUIPEDIA_INTERVAL_MS - now, parse && last.parse !== null ? last.parse + PARSE_INTERVAL_MS - now : 0)
  }

  private locked<T>(run: () => T): T | undefined {
    let fd: number | undefined
    const lock = join(this.directory, 'liquipedia.lock')
    try {
      mkdirSync(this.directory, { recursive: true })
      try { fd = openSync(lock, 'wx', 0o600) } catch {
        // Never steal from a live owner. Recover only a sufficiently old abandoned mutex.
        const owner = readJson(lock), stat = lstatSync(lock)
        if (this.now() - stat.mtimeMs < 2 * PARSE_INTERVAL_MS || !owner || !Number.isSafeInteger(owner.pid)) return undefined
        let dead = false
        try { process.kill(Number(owner.pid), 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        if (!dead) return undefined
        unlinkSync(lock)
        fd = openSync(lock, 'wx', 0o600)
      }
      writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      return run()
    } catch { return undefined }
    finally {
      if (fd !== undefined) {
        closeSync(fd)
        try { unlinkSync(lock) } catch { /* A failed cleanup must not dispatch an unreserved request. */ }
      }
    }
  }

  private save(last: RequestTimes): void {
    atomicJson(this.directory, HTTP_ATTEMPT, { at: last.http ?? timestamp(this.now()),
      ...(last.parse === null ? {} : { parseAt: last.parse }), ...(last.cooldown ? { cooldown: last.cooldown } : {}) })
  }

  private recordSlot(last: RequestTimes, now: number, parse: boolean): void {
    this.save({ ...last, http: now, parse: parse ? now : last.parse })
    if (parse) atomicJson(this.directory, PARSE_ATTEMPT, { at: now })
  }

  reserve(parse = false): boolean {
    if (this.cooldown()) return false
    return this.locked(() => {
      const now = timestamp(this.now()), last = this.timestamps()
      if ((last.cooldown && last.cooldown.until > now) || this.slotDelay(last, now, parse) > 0) return false
      // Keep both quotas in this atomic record so a crash between writes cannot lose the parse quota.
      this.recordSlot(last, now, parse)
      return true
    }) ?? false
  }

  async rateLimited(retryAfter: string | null, signal: AbortSignal, serverDate?: string | null): Promise<LiquipediaCooldown> {
    const at = timestamp(this.now())
    const id = randomUUID()
    const delay = retryAfterDelay(retryAfter, at, serverDate)
    const next = (previous: LiquipediaCooldown | null): LiquipediaCooldown => {
      const count = Math.min(16, (previous?.count ?? 0) + 1)
      const backoff = Math.min(MAX_COOLDOWN_BACKOFF_MS, (delay ?? DEFAULT_COOLDOWN_MS) * 2 ** (count - 1))
      const until = Math.min(8_640_000_000_000_000, at + Math.max(PARSE_INTERVAL_MS, delay ?? 0, backoff))
      const retryAfterUntil = Math.max(previous ? verificationNotBefore(previous) : 0,
        Math.min(8_640_000_000_000_000, at + (delay ?? 0)))
      return { id, at, until: Math.max(previous?.until ?? 0, until), count, retryAfterUntil,
        ...(retryAfter && retryAfter.length <= 256 ? { retryAfter } : {}) }
    }
    this.pendingCooldowns.set(id, next(this.cooldown()))
    for (;;) {
      const saved = this.locked(() => {
        const last = this.timestamps(), cooldown = next(last.cooldown)
        this.save({ ...last, cooldown })
        return cooldown
      })
      if (saved) {
        this.pendingCooldowns.delete(id)
        this.localCooldown = saved
        return { ...saved }
      }
      signal.throwIfAborted()
      await pause(100, signal)
    }
  }

  async waitForVerification(round: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      if (!this.isVerificationRound(round)) throw new VerificationRoundEnded()
      const delay = this.locked(() => {
        const now = timestamp(this.now()), last = this.timestamps(), value = last.cooldown
        if (!value || value.until <= now || cooldownRound(value) !== round) return -1
        const wait = Math.max(this.slotDelay(last, now, true), verificationNotBefore(value) - now)
        if (wait === 0) this.recordSlot(last, now, true)
        return wait
      })
      if (delay === -1) throw new VerificationRoundEnded()
      if (delay === 0) return
      await pause(Math.max(25, delay ?? 0), signal)
    }
  }

  isVerificationRound(round: string): boolean {
    const value = this.cooldown()
    return this.pendingCooldowns.size === 0 && value !== null && cooldownRound(value) === round
  }

  async succeededVerification(round: string, signal: AbortSignal): Promise<boolean> {
    for (;;) {
      signal.throwIfAborted()
      this.effectiveCooldown(null)
      if (this.pendingCooldowns.size) return false
      const cleared = this.locked(() => {
        const last = this.timestamps()
        if (!last.cooldown || cooldownRound(last.cooldown) !== round) return false
        this.save({ ...last, cooldown: null })
        this.localCooldown = null
        return true
      })
      if (cleared !== undefined) return cleared
      await pause(25, signal)
    }
  }

  /** An old in-flight success cannot lift a newer rate-limit block. */
  succeeded(startedAt: number): void {
    const cleared = this.locked(() => {
      const last = this.timestamps()
      if (!last.cooldown || startedAt < last.cooldown.until || this.now() < last.cooldown.until) return false
      this.save({ ...last, cooldown: null })
      return true
    })
    if (cleared && (!this.localCooldown || startedAt >= this.localCooldown.until)) this.localCooldown = null
  }

  async wait(signal: AbortSignal, parse = false): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      this.throwIfCooling()
      if (this.reserve(parse)) return
      await pause(Math.max(25, this.delay(parse)), signal)
    }
  }
}

export type DispatchKind = 'logo' | 'tier'

/**
 * Crests and the tier query share the 2-second HTTP slot. While both wait for it they take
 * turns, a crest first, so the query neither holds crests back nor starves behind them; a kind
 * waiting alone takes every slot. Only waiting to send counts: a slow tier answer holds nothing.
 */
export class DispatchTurns {
  private readonly waiting: Record<DispatchKind, number> = { logo: 0, tier: 0 }
  private last: DispatchKind | null = null
  constructor(readonly rateLimit: LiquipediaRateLimit) {}

  /** Mark `kind` as waiting to send until the returned release is called (more calls are no-ops). */
  hold(kind: DispatchKind): () => void {
    this.waiting[kind]++
    let held = true
    return () => { if (held) { held = false; this.waiting[kind]-- } }
  }

  mayGo(kind: DispatchKind): boolean {
    const other: DispatchKind = kind === 'logo' ? 'tier' : 'logo'
    return this.waiting[other] === 0 || this.last === other || (this.last === null && kind === 'logo')
  }

  /** Record a reserved slot, so the other kind goes next if it is waiting. */
  sent(kind: DispatchKind): void { this.last = kind }

  get idle(): boolean { return this.waiting.logo === 0 && this.waiting.tier === 0 }

  /** Wait for `kind`'s turn and reserve the slot. */
  async wait(kind: DispatchKind, signal: AbortSignal): Promise<void> {
    const release = this.hold(kind)
    try {
      for (;;) {
        signal.throwIfAborted()
        this.rateLimit.throwIfCooling()
        if (this.mayGo(kind) && this.rateLimit.reserve()) { this.sent(kind); return }
        await pause(Math.max(25, this.rateLimit.delay()), signal)
      }
    } finally { release() }
  }
}
