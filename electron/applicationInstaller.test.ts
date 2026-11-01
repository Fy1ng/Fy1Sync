import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchApplicationInstaller, supportsApplicationInstall } from './applicationInstaller'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('fy1sync-installer-')) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fy1sync-installer-'))
  roots.push(root)
  const directory = path.join(root, 'online-updates/installers')
  fs.mkdirSync(directory, { recursive: true })
  const bytes = Buffer.from('INERT TEST FILE - NEVER EXECUTED')
  const installer = path.join(directory, `${createHash('sha256').update(bytes).digest('hex')}.exe`)
  fs.writeFileSync(installer, bytes)
  return { root, installer }
}

describe('explicit full application installer launch', () => {
  it('launches only the verified private cache file without a shell or silent elevation flags', async () => {
    const f = fixture()
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    const launch = vi.fn(() => { queueMicrotask(() => child.emit('spawn')); return child })
    await launchApplicationInstaller(f.root, f.installer, launch as unknown as typeof spawn)
    expect(launch).toHaveBeenCalledWith(f.installer, ['--updated', '/CURRENTUSER'], { shell: false, detached: true, windowsHide: true, stdio: 'ignore' })
    expect(child.unref).toHaveBeenCalledOnce()
  })
  it('does not fall back to shell opening on a failed native launch', async () => {
    const f = fixture()
    const child = new EventEmitter()
    const launch = vi.fn(() => { queueMicrotask(() => child.emit('error', new Error('sensitive local path'))); return child })
    await expect(launchApplicationInstaller(f.root, f.installer, launch as unknown as typeof spawn)).rejects.toThrow('没有安装更新')
    expect(launch).toHaveBeenCalledOnce()
  })
  it('rejects renderer-like arbitrary paths before any process can start', async () => {
    const f = fixture(), launch = vi.fn()
    for (const file of [path.join(f.root, 'outside.exe'), path.join(f.root, 'online-updates/installers/untrusted.exe'), 'https://updates.example.org/installer.exe']) {
      await expect(launchApplicationInstaller(f.root, file, launch as unknown as typeof spawn)).rejects.toThrow()
    }
    expect(launch).not.toHaveBeenCalled()
  })
  it('rechecks the installer after normal shutdown before spawning any executable', async () => {
    const f = fixture(), launch = vi.fn()
    fs.writeFileSync(f.installer, 'CHANGED AFTER INITIAL VERIFICATION')
    await expect(launchApplicationInstaller(f.root, f.installer, launch as unknown as typeof spawn)).rejects.toThrow('校验')
    expect(launch).not.toHaveBeenCalled()
  })
  it('does not present portable, development or unsupported builds as installable', () => {
    const f = fixture(), executable = path.join(f.root, 'Fy1Sync.exe')
    fs.writeFileSync(executable, 'TEST')
    const options = { packaged: true, platform: 'win32', arch: 'x64', executable }
    expect(supportsApplicationInstall(options)).toBe(false)
    fs.writeFileSync(path.join(f.root, 'Uninstall Fy1Sync.exe'), 'TEST')
    expect(supportsApplicationInstall(options)).toBe(true)
    expect(supportsApplicationInstall({ ...options, packaged: false })).toBe(false)
    expect(supportsApplicationInstall({ ...options, platform: 'darwin' })).toBe(false)
    expect(supportsApplicationInstall({ ...options, arch: 'arm64' })).toBe(false)
  })
})
