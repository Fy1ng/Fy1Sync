import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export type StartupStage = 'booting' | 'window-created' | 'healthy' | 'clean-exit'

export interface StartupState {
  version: 1
  uncleanBoots: number
  gpuCrashCount: number
  rendererCrashCount: number
  disableHardwareAcceleration: boolean
  lastStage: StartupStage
  updatedAt: number
}

export interface BootDecision {
  disableHardwareAcceleration: boolean
  selfHealed: boolean
  cachesPurged: string[]
  state: StartupState
}

export interface StartupGuardOptions {
  forceHardwareAcceleration?: boolean
  forceDisableGpu?: boolean
  now?: () => number
}

export const STARTUP_STATE_FILE = 'startup-state.json'
const MAX_STATE_BYTES = 4096
const CRASH_THRESHOLD = 2

/** Pure transient Chromium cache directories safe to purge without affecting user credentials or settings. */
export const TRANSIENT_CHROMIUM_CACHES = [
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Code Cache',
  'Cache',
] as const

const STAGES: ReadonlySet<string> = new Set(['booting', 'window-created', 'healthy', 'clean-exit'])

function defaultState(now: number): StartupState {
  return {
    version: 1,
    uncleanBoots: 0,
    gpuCrashCount: 0,
    rendererCrashCount: 0,
    disableHardwareAcceleration: false,
    lastStage: 'clean-exit',
    updatedAt: now,
  }
}

function clampCounter(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(10, value) : 0
}

function readState(file: string, now: number): StartupState {
  let fd: number | undefined
  try {
    const lstat = fs.lstatSync(file)
    if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size > MAX_STATE_BYTES) return defaultState(now)
    fd = fs.openSync(file, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return defaultState(now)
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    let length = 0
    for (;;) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null)
      length += count
      if (!count || length > MAX_STATE_BYTES) break
    }
    if (length > MAX_STATE_BYTES) return defaultState(now)
    const raw: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState(now)
    const record = raw as Record<string, unknown>
    if (record.version !== 1) return defaultState(now)
    return {
      version: 1,
      uncleanBoots: clampCounter(record.uncleanBoots),
      gpuCrashCount: clampCounter(record.gpuCrashCount),
      rendererCrashCount: clampCounter(record.rendererCrashCount),
      disableHardwareAcceleration: record.disableHardwareAcceleration === true,
      lastStage: typeof record.lastStage === 'string' && STAGES.has(record.lastStage)
        ? record.lastStage as StartupStage
        : 'clean-exit',
      updatedAt: typeof record.updatedAt === 'number' && Number.isSafeInteger(record.updatedAt) && record.updatedAt >= 0
        ? record.updatedAt
        : now,
    }
  } catch {
    return defaultState(now)
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* Ignore close errors. */ }
    }
  }
}

function writeState(root: string, file: string, state: StartupState): void {
  let temporary: string | undefined
  let fd: number | undefined
  try {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return
    if (fs.existsSync(file)) {
      const fileStat = fs.lstatSync(file)
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) return
    }
    temporary = path.join(root, `.startup-state-${randomUUID()}.tmp`)
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(state) + '\n', 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
    temporary = undefined
  } catch {
    // Sentinel persistence is best-effort and must never block startup.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* Ignore close errors. */ }
    }
    if (temporary !== undefined) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* Ignore cleanup errors. */ }
    }
  }
}

/** Remove only allow-listed Chromium shader/code/HTTP caches inside userData, never following links. */
export function purgeTransientChromiumCaches(userDataDir: string, names: readonly string[] = TRANSIENT_CHROMIUM_CACHES): string[] {
  const purged: string[] = []
  try {
    const root = path.resolve(userDataDir)
    if (!fs.existsSync(root)) return purged
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return purged
    const allowed = new Set<string>(TRANSIENT_CHROMIUM_CACHES)
    for (const name of names) {
      if (!allowed.has(name)) continue
      const target = path.join(root, name)
      try {
        if (!fs.existsSync(target)) continue
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue
        fs.rmSync(target, { recursive: true, force: true })
        purged.push(name)
      } catch {
        // Locked cache files are skipped without failing recovery.
      }
    }
  } catch {
    return purged
  }
  return purged
}

/**
 * Tracks startup completion and GPU/renderer crashes across launches so native
 * Chromium GPU fatalities (`0x80000003`) or corrupt shader/code caches self-heal
 * on the next launch even when NSIS reinstalls preserve `%APPDATA%\Fy1Sync`.
 */
export class StartupGuard {
  private readonly root: string
  private readonly file: string
  private readonly now: () => number
  private state: StartupState
  private booted = false

  constructor(userDataDir: string, private readonly options: StartupGuardOptions = {}) {
    this.root = path.resolve(userDataDir)
    this.file = path.join(this.root, STARTUP_STATE_FILE)
    this.now = options.now ?? Date.now
    this.state = readState(this.file, this.now())
  }

  snapshot(): StartupState {
    return { ...this.state }
  }

  beginBoot(): BootDecision {
    if (this.booted) {
      return {
        disableHardwareAcceleration: Boolean(this.options.forceDisableGpu || (!this.options.forceHardwareAcceleration && this.state.disableHardwareAcceleration)),
        selfHealed: false,
        cachesPurged: [],
        state: this.snapshot(),
      }
    }
    this.booted = true
    const timestamp = this.now()
    const previous = this.state

    if (this.options.forceHardwareAcceleration) {
      this.state = {
        version: 1,
        uncleanBoots: 0,
        gpuCrashCount: 0,
        rendererCrashCount: 0,
        disableHardwareAcceleration: false,
        lastStage: 'booting',
        updatedAt: timestamp,
      }
      writeState(this.root, this.file, this.state)
      return { disableHardwareAcceleration: false, selfHealed: false, cachesPurged: [], state: this.snapshot() }
    }

    const interrupted = previous.lastStage === 'booting' || previous.lastStage === 'window-created'
    const uncleanBoots = interrupted ? Math.min(10, previous.uncleanBoots + 1) : 0
    const crashTriggered = previous.gpuCrashCount >= CRASH_THRESHOLD
      || previous.rendererCrashCount >= CRASH_THRESHOLD
      || uncleanBoots >= CRASH_THRESHOLD
    const selfHealed = crashTriggered && (!previous.disableHardwareAcceleration || interrupted || previous.gpuCrashCount > 0 || previous.rendererCrashCount > 0)
    const cachesPurged = selfHealed ? purgeTransientChromiumCaches(this.root) : []
    const disableHardwareAcceleration = Boolean(this.options.forceDisableGpu || previous.disableHardwareAcceleration || crashTriggered)

    this.state = {
      version: 1,
      uncleanBoots,
      gpuCrashCount: previous.gpuCrashCount,
      rendererCrashCount: previous.rendererCrashCount,
      disableHardwareAcceleration,
      lastStage: 'booting',
      updatedAt: timestamp,
    }
    writeState(this.root, this.file, this.state)

    return {
      disableHardwareAcceleration,
      selfHealed,
      cachesPurged,
      state: this.snapshot(),
    }
  }

  markWindowCreated(): void {
    if (this.state.lastStage === 'healthy') return
    this.state = { ...this.state, lastStage: 'window-created', updatedAt: this.now() }
    writeState(this.root, this.file, this.state)
  }

  recordGpuCrash(): StartupState {
    const gpuCrashCount = Math.min(10, this.state.gpuCrashCount + 1)
    const disableHardwareAcceleration = this.state.disableHardwareAcceleration || gpuCrashCount >= CRASH_THRESHOLD
    this.state = {
      ...this.state,
      gpuCrashCount,
      disableHardwareAcceleration,
      updatedAt: this.now(),
    }
    writeState(this.root, this.file, this.state)
    return this.snapshot()
  }

  recordRendererCrash(): StartupState {
    const rendererCrashCount = Math.min(10, this.state.rendererCrashCount + 1)
    const disableHardwareAcceleration = this.state.disableHardwareAcceleration || rendererCrashCount >= CRASH_THRESHOLD
    this.state = {
      ...this.state,
      rendererCrashCount,
      disableHardwareAcceleration,
      updatedAt: this.now(),
    }
    writeState(this.root, this.file, this.state)
    return this.snapshot()
  }

  markHealthy(): StartupState {
    this.state = {
      ...this.state,
      uncleanBoots: 0,
      gpuCrashCount: 0,
      rendererCrashCount: 0,
      lastStage: 'healthy',
      updatedAt: this.now(),
    }
    writeState(this.root, this.file, this.state)
    return this.snapshot()
  }

  markCleanExit(): StartupState {
    this.state = {
      ...this.state,
      uncleanBoots: 0,
      lastStage: 'clean-exit',
      updatedAt: this.now(),
    }
    writeState(this.root, this.file, this.state)
    return this.snapshot()
  }

  /** Used by manual recovery actions before relaunching into software-rendered safe mode. */
  prepareSafeRestart(): string[] {
    const purged = purgeTransientChromiumCaches(this.root)
    this.state = {
      version: 1,
      uncleanBoots: 0,
      gpuCrashCount: 0,
      rendererCrashCount: 0,
      disableHardwareAcceleration: true,
      lastStage: 'clean-exit',
      updatedAt: this.now(),
    }
    writeState(this.root, this.file, this.state)
    return purged
  }
}
