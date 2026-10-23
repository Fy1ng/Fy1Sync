import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopService, type DesktopService } from './api'
import { resolveConfig } from './config'
import { DecoderPreferences } from '../electron/decoderPreferences'

describe('decoder preference IPC service', () => {
  let directory: string
  let preferences: DecoderPreferences
  let service: DesktopService
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'stream-sync-decoder-ipc-'))
    preferences = new DecoderPreferences(directory)
    service = createDesktopService({ dataDir: directory, proxy: resolveConfig({}).proxy, registerMedia: url => url, decoderPreferences: preferences })
  })
  afterEach(async () => { service.dispose(); await rm(directory, { recursive: true, force: true }) })

  it('reads and saves typed state without changing this process effective mode', async () => {
    expect(await service.invoke('getDecoderPreferences', undefined)).toMatchObject({ ok: true, value: { mode: 'auto', effectiveMode: 'auto' } })
    expect(await service.invoke('setDecoderPreferences', { mode: 'software' })).toMatchObject({ ok: true, value: { mode: 'software', effectiveMode: 'auto', restartRequired: true } })
    expect(new DecoderPreferences(directory).get().mode).toBe('software')
  })

  it.each([undefined, null, [], {}, { mode: true }, { mode: 'unknown' }, { mode: 'software', path: 'anywhere' }, { mode: 'software', extra: undefined }])(
    'rejects invalid fields or enum values without persisting', async args => {
      const save = vi.spyOn(preferences, 'set')
      expect(await service.invoke('setDecoderPreferences', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
      expect(save).not.toHaveBeenCalled()
    })

  it('rejects read parameters and sanitizes write failures', async () => {
    expect(await service.invoke('getDecoderPreferences', {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    vi.spyOn(preferences, 'set').mockRejectedValue(new Error('C:/private/user/file.json: access denied'))
    expect(await service.invoke('setDecoderPreferences', { mode: 'software' })).toEqual({ ok: false, code: 'settings-write-failed', message: '解码设置保存失败, 请重试' })
    expect(preferences.get().mode).toBe('auto')
  })
})
