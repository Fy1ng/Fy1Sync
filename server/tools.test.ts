import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopService } from './api'
import { resolveConfig } from './config'

describe('tool management API validation', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'syncer-tools-api-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const methods = () => ({ status: vi.fn(async () => ({} as any)), update: vi.fn(async () => ({} as any)), restore: vi.fn(async () => ({} as any)) })
  it.each([
    ['getToolsStatus', {}], ['updateYtdlp', { url: 'https://untrusted.invalid/evil.exe' }], ['updateYtdlp', { path: 'C:/evil.exe' }],
    ['updateYtdlp', { command: ['--exec', 'arbitrary'] }], ['restoreYtdlp', { target: '../../evil' }],
    ['restoreYtdlp', { target: 'bundled', url: 'https://untrusted.invalid' }], ['restoreYtdlp', undefined],
  ])('rejects malicious or extra arguments to %s before invoking tools', async (method, args) => {
    const tools = methods()
    const service = createDesktopService({ dataDir: root, proxy: resolveConfig({}).proxy, registerMedia: s => s, tools })
    expect(await service.invoke(method, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(tools.status).not.toHaveBeenCalled(); expect(tools.update).not.toHaveBeenCalled(); expect(tools.restore).not.toHaveBeenCalled()
    service.dispose()
  })
  it('accepts only fixed methods with no arbitrary destination capability', async () => {
    const tools = methods()
    const service = createDesktopService({ dataDir: root, proxy: resolveConfig({}).proxy, registerMedia: s => s, tools })
    expect((await service.invoke('getToolsStatus', undefined)).ok).toBe(true)
    expect((await service.invoke('updateYtdlp', undefined)).ok).toBe(true)
    expect((await service.invoke('restoreYtdlp', { target: 'previous' })).ok).toBe(true)
    expect((await service.invoke('restoreYtdlp', { target: 'bundled' })).ok).toBe(true)
    expect(tools.restore.mock.calls).toEqual([['previous'], ['bundled']])
    service.dispose()
  })
})
