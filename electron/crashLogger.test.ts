import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCrashLogger } from './crashLogger'

const roots: string[] = []

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1sync-crash-logger-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('fy1sync-crash-logger-test-')) {
      throw new Error('Unexpected test cleanup path')
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('crashLogger', () => {
  it('writes structured lines and redacts user paths, cookies, and bearer tokens', () => {
    const root = makeTempRoot()
    const logger = createCrashLogger(root, { now: () => Date.UTC(2026, 10, 25, 12, 0, 0) })

    logger.info('boot-begin', { version: '0.5.1', disableHardwareAcceleration: false })
    logger.error(
      'startup-failure',
      new Error('EACCES C:\\Users\\Alice\\AppData\\Roaming\\Fy1Sync Cookie: SESSDATA=secret_cookie Authorization: Bearer top_secret_token'),
      { stage: 'loadURL' },
    )

    expect(fs.existsSync(logger.logFilePath)).toBe(true)
    const content = fs.readFileSync(logger.logFilePath, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('2026-11-25T12:00:00.000Z [INFO] boot-begin')
    expect(lines[1]).toContain('2026-11-25T12:00:00.000Z [ERROR] startup-failure ')
    const parsed = JSON.parse(lines[1]!.slice('2026-11-25T12:00:00.000Z [ERROR] startup-failure '.length)) as {
      error: { message: string }
    }
    expect(parsed.error.message).toContain('[user]\\AppData\\Roaming\\Fy1Sync')
    expect(content).not.toContain('Alice')
    expect(content).not.toContain('secret_cookie')
    expect(content).not.toContain('top_secret_token')
  })

  it('rotates startup.log to startup.prev.log when exceeding maxBytes', () => {
    const root = makeTempRoot()
    const logger = createCrashLogger(root, { now: () => 1_700_000_000_000, maxBytes: 260 })

    logger.info('first-entry', { pad: 'a'.repeat(120) })
    logger.warn('second-entry', 'warning message', { pad: 'b'.repeat(120) })

    const prevPath = path.join(logger.logDir, 'startup.prev.log')
    expect(fs.existsSync(prevPath)).toBe(true)
    expect(fs.readFileSync(prevPath, 'utf8')).toContain('first-entry')
    expect(fs.readFileSync(logger.logFilePath, 'utf8')).toContain('second-entry')
  })

  it('never throws and refuses symlinked log directories', () => {
    const root = makeTempRoot()
    const outside = makeTempRoot()
    fs.symlinkSync(outside, path.join(root, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')

    const logger = createCrashLogger(root)
    expect(() => logger.error('blocked-write', new Error('boom'))).not.toThrow()
    expect(fs.existsSync(path.join(outside, 'startup.log'))).toBe(false)
  })
})
