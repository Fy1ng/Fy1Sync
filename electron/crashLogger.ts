import fs from 'node:fs'
import path from 'node:path'
import { errorDetails, redactErrorText } from '../src/core/errorDetails'

const DEFAULT_MAX_BYTES = 512 * 1024
const MAX_LINE_LENGTH = 4096

export interface CrashLoggerOptions {
  now?: () => number
  maxBytes?: number
}

export interface CrashLogger {
  readonly logDir: string
  readonly logFilePath: string
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, error?: unknown, fields?: Record<string, unknown>): void
  error(event: string, error?: unknown, fields?: Record<string, unknown>): void
}

function ensureRegularDir(target: string): boolean {
  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    const stat = fs.lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isSafeLogTarget(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return true
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= 1
  } catch {
    return false
  }
}

function formatLine(timestamp: number, level: 'INFO' | 'WARN' | 'ERROR', event: string, error?: unknown, fields?: Record<string, unknown>): string {
  const iso = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString()
  const payload: Record<string, unknown> = {}
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) payload[key] = value
    }
  }
  if (error !== undefined) {
    payload.error = error
  }
  const cleanEvent = redactErrorText(event).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || 'event'
  let serialized = ''
  if (Object.keys(payload).length > 0) {
    try {
      serialized = ' ' + JSON.stringify(errorDetails(payload))
    } catch {
      serialized = ' {"detail":"[unavailable]"}'
    }
  }
  const raw = `${iso} [${level}] ${cleanEvent}${serialized}`
  return (raw.length > MAX_LINE_LENGTH ? raw.slice(0, MAX_LINE_LENGTH) + '…' : raw) + '\n'
}

/** Synchronous, bounded, redacted startup and crash log writer. Never throws. */
export function createCrashLogger(userDataDir: string, options: CrashLoggerOptions = {}): CrashLogger {
  const root = path.resolve(userDataDir)
  const logDir = path.join(root, 'logs')
  const logFilePath = path.join(logDir, 'startup.log')
  const previousLogPath = path.join(logDir, 'startup.prev.log')
  const now = options.now ?? Date.now
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  const write = (level: 'INFO' | 'WARN' | 'ERROR', event: string, error?: unknown, fields?: Record<string, unknown>): void => {
    try {
      if (!ensureRegularDir(root) || !ensureRegularDir(logDir)) return
      if (!isSafeLogTarget(logFilePath) || !isSafeLogTarget(previousLogPath)) return
      const line = formatLine(now(), level, event, error, fields)
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (fs.existsSync(logFilePath)) {
        const stat = fs.lstatSync(logFilePath)
        if (stat.size + lineBytes > maxBytes) {
          try { fs.rmSync(previousLogPath, { force: true }) } catch { /* Best-effort rotation. */ }
          try { fs.renameSync(logFilePath, previousLogPath) } catch { /* Keep writing if busy. */ }
        }
      }
      const fd = fs.openSync(logFilePath, 'a', 0o600)
      try {
        const stat = fs.fstatSync(fd)
        if (stat.isFile()) {
          fs.writeFileSync(fd, line, 'utf8')
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // Diagnostic logging must never interrupt startup or crash recovery.
    }
  }

  return {
    logDir,
    logFilePath,
    info: (event, fields) => write('INFO', event, undefined, fields),
    warn: (event, error, fields) => write('WARN', event, error, fields),
    error: (event, error, fields) => write('ERROR', event, error, fields),
  }
}
