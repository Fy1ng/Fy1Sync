import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LIQUIPEDIA_INTERVAL_MS = 2_000
export const PARSE_INTERVAL_MS = 30_000
const HTTP_ATTEMPT = 'liquipedia-http-attempt.json'
const PARSE_ATTEMPT = 'liquipedia-attempt.json'

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

function pause(ms: number, signal: AbortSignal): Promise<void> {
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
  constructor(userDataDir: string, private readonly now: () => number = Date.now) {
    this.directory = join(resolve(userDataDir), 'events')
  }

  private timestamps(): { http: number | null; parse: number | null } {
    const http = readJson(join(this.directory, HTTP_ATTEMPT))
    const legacy = readJson(join(this.directory, PARSE_ATTEMPT))
    const parseTimes = [legacy ? timestamp(legacy.at) : null, http?.parseAt === undefined ? null : timestamp(http.parseAt)]
      .filter((value): value is number => value !== null)
    return { http: http ? timestamp(http.at) : null, parse: parseTimes.length ? Math.max(...parseTimes) : null }
  }

  delay(parse = false): number {
    try {
      const now = timestamp(this.now()), last = this.timestamps()
      // The legacy parse record also represents an HTTP request made before migration.
      const httpTimes = [last.http, last.parse].filter((value): value is number => value !== null)
      const httpDelay = httpTimes.length ? Math.max(...httpTimes) + LIQUIPEDIA_INTERVAL_MS - now : 0
      return Math.max(0, httpDelay, parse && last.parse !== null ? last.parse + PARSE_INTERVAL_MS - now : 0)
    } catch { return parse ? PARSE_INTERVAL_MS : LIQUIPEDIA_INTERVAL_MS }
  }

  reserve(parse = false): boolean {
    let fd: number | undefined
    const lock = join(this.directory, 'liquipedia.lock')
    try {
      mkdirSync(this.directory, { recursive: true })
      try { fd = openSync(lock, 'wx', 0o600) } catch {
        // Never steal from a live owner. Recover only a sufficiently old abandoned mutex.
        const owner = readJson(lock), stat = lstatSync(lock)
        if (this.now() - stat.mtimeMs < 2 * PARSE_INTERVAL_MS || !owner || !Number.isSafeInteger(owner.pid)) return false
        let dead = false
        try { process.kill(Number(owner.pid), 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        if (!dead) return false
        unlinkSync(lock)
        fd = openSync(lock, 'wx', 0o600)
      }
      writeFileSync(fd, JSON.stringify({ pid: process.pid }))
      const now = timestamp(this.now()), last = this.timestamps()
      const http = Math.max(last.http ?? -LIQUIPEDIA_INTERVAL_MS, last.parse ?? -LIQUIPEDIA_INTERVAL_MS)
      if (now - http < LIQUIPEDIA_INTERVAL_MS || (parse && last.parse !== null && now - last.parse < PARSE_INTERVAL_MS)) return false
      // Keep both quotas in this atomic record so a crash between writes cannot lose the parse quota.
      atomicJson(this.directory, HTTP_ATTEMPT, { at: now, ...(parse || last.parse !== null ? { parseAt: parse ? now : last.parse } : {}) })
      if (parse) atomicJson(this.directory, PARSE_ATTEMPT, { at: now })
      return true
    } catch { return false }
    finally {
      if (fd !== undefined) {
        closeSync(fd)
        try { unlinkSync(lock) } catch { /* A failed cleanup must not dispatch an unreserved request. */ }
      }
    }
  }

  async wait(signal: AbortSignal, parse = false): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      if (this.reserve(parse)) return
      await pause(Math.max(25, this.delay(parse)), signal)
    }
  }
}
