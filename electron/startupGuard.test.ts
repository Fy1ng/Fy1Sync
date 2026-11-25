import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STARTUP_STATE_FILE, StartupGuard, TRANSIENT_CHROMIUM_CACHES, purgeTransientChromiumCaches } from './startupGuard'

const roots: string[] = []

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1sync-startup-guard-test-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('fy1sync-startup-guard-test-')) {
      throw new Error('Unexpected test cleanup path')
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('StartupGuard and transient cache self-healing', () => {
  it('tracks normal boot, healthy state, and short-lived clean exits without disabling GPU', () => {
    const root = makeTempRoot()
    const first = new StartupGuard(root, { now: () => 100 })
    expect(first.beginBoot()).toMatchObject({
      disableHardwareAcceleration: false,
      selfHealed: false,
      cachesPurged: [],
    })
    first.markWindowCreated()
    first.markCleanExit()

    const second = new StartupGuard(root, { now: () => 200 })
    const secondBoot = second.beginBoot()
    expect(secondBoot.disableHardwareAcceleration).toBe(false)
    expect(secondBoot.state.uncleanBoots).toBe(0)
    second.markHealthy()
    second.markCleanExit()
    expect(second.snapshot()).toMatchObject({
      uncleanBoots: 0,
      gpuCrashCount: 0,
      rendererCrashCount: 0,
      disableHardwareAcceleration: false,
      lastStage: 'clean-exit',
    })
  })

  it('auto-disables hardware acceleration and purges only allow-listed caches after GPU crash loop', () => {
    const root = makeTempRoot()
    for (const cache of TRANSIENT_CHROMIUM_CACHES) {
      const dir = path.join(root, cache)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'entry.bin'), 'corrupt-shader')
    }
    // User credentials, cookies, saved rooms, and local storage must never be touched.
    for (const preserved of ['cookies', 'douyu', 'rooms', 'events', 'Local Storage']) {
      const dir = path.join(root, preserved)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'keep.json'), '{"ok":true}')
    }

    const crashing = new StartupGuard(root, { now: () => 1_000 })
    expect(crashing.beginBoot().disableHardwareAcceleration).toBe(false)
    crashing.markWindowCreated()
    crashing.recordGpuCrash()
    crashing.recordGpuCrash()
    // Simulate Chromium C++ LOG(FATAL) 0x80000003 killing the process before before-quit.

    const recovered = new StartupGuard(root, { now: () => 2_000 })
    const decision = recovered.beginBoot()
    expect(decision.disableHardwareAcceleration).toBe(true)
    expect(decision.selfHealed).toBe(true)
    expect(decision.cachesPurged).toEqual([...TRANSIENT_CHROMIUM_CACHES])
    for (const cache of TRANSIENT_CHROMIUM_CACHES) {
      expect(fs.existsSync(path.join(root, cache))).toBe(false)
    }
    for (const preserved of ['cookies', 'douyu', 'rooms', 'events', 'Local Storage']) {
      expect(fs.readFileSync(path.join(root, preserved, 'keep.json'), 'utf8')).toBe('{"ok":true}')
    }

    recovered.markHealthy()
    recovered.markCleanExit()

    // Subsequent launch stays in stable software mode without repeatedly wiping HTTP cache once healthy.
    fs.mkdirSync(path.join(root, 'Cache'), { recursive: true })
    const third = new StartupGuard(root, { now: () => 3_000 })
    const thirdDecision = third.beginBoot()
    expect(thirdDecision.disableHardwareAcceleration).toBe(true)
    expect(thirdDecision.selfHealed).toBe(false)
    expect(fs.existsSync(path.join(root, 'Cache'))).toBe(true)

    // Explicit CLI flag --enable-hardware-acceleration resets safe mode.
    const reenabled = new StartupGuard(root, { forceHardwareAcceleration: true, now: () => 4_000 })
    expect(reenabled.beginBoot().disableHardwareAcceleration).toBe(false)
  })

  it('triggers safe-mode self-healing after repeated interrupted boots even without JS crash callbacks', () => {
    const root = makeTempRoot()
    fs.mkdirSync(path.join(root, 'GPUCache'), { recursive: true })

    new StartupGuard(root).beginBoot()
    const second = new StartupGuard(root)
    expect(second.beginBoot().disableHardwareAcceleration).toBe(false)

    const third = new StartupGuard(root)
    const decision = third.beginBoot()
    expect(decision.disableHardwareAcceleration).toBe(true)
    expect(decision.selfHealed).toBe(true)
    expect(decision.cachesPurged).toContain('GPUCache')
  })

  it('supports manual prepareSafeRestart, tolerates corrupt state, and never follows cache junctions', () => {
    const root = makeTempRoot()
    const outside = makeTempRoot()
    fs.writeFileSync(path.join(outside, 'external.txt'), 'protected')
    fs.symlinkSync(outside, path.join(root, 'GPUCache'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.mkdirSync(path.join(root, 'Code Cache'), { recursive: true })
    fs.writeFileSync(path.join(root, STARTUP_STATE_FILE), '\u0000\u0000{corrupt')

    expect(purgeTransientChromiumCaches(root, ['GPUCache', 'cookies'])).toEqual([])
    expect(fs.readFileSync(path.join(outside, 'external.txt'), 'utf8')).toBe('protected')

    const guard = new StartupGuard(root)
    const purged = guard.prepareSafeRestart()
    expect(purged).toEqual(['Code Cache'])
    expect(fs.readFileSync(path.join(outside, 'external.txt'), 'utf8')).toBe('protected')

    const relaunched = new StartupGuard(root)
    expect(relaunched.beginBoot().disableHardwareAcceleration).toBe(true)
  })
})
