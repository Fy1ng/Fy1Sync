import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopService, type DesktopService } from './api'
import { resolveConfig } from './config'
import { etagFor, PresetStore, type PresetRecord } from './presetStore'
import { createEmptyHudStylePack } from '../src/core/hudStylePack'
import type { StylePackSyncEvent, StylePackSyncState } from '../electron/stylePackSyncContracts'

describe('cloud style pack desktop boundary', () => {
  let root: string
  let service: DesktopService
  let cloud: PresetRecord
  let notify: ((event: StylePackSyncEvent) => void) | undefined
  const state: StylePackSyncState = { source: 'github', availableSources: ['github', 'gitcode'], catalogRevision: 1, phase: 'current', checkedAt: 1, updatedAt: 1,
    installed: 1, downloaded: 0, incompatible: 0, message: '已是最新.' }
  const sync = vi.fn(async () => state)
  const setSource = vi.fn((source: 'github' | 'gitcode') => ({ ...state, source }))
  const release = vi.fn()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy1sync-cloud-api-'))
    const profile = createEmptyHudStylePack('cs2/iem', 'Cloud IEM')
    cloud = { id: profile.id, profile, etag: etagFor(profile), updatedAt: 1 }
    notify = undefined
    sync.mockClear(); release.mockClear(); setSource.mockClear()
    service = createDesktopService({ dataDir: root, proxy: resolveConfig({}).proxy,
      registerMedia: url => url, stylePacks: {
        list: async () => [structuredClone(cloud)], get: async id => id === cloud.id ? structuredClone(cloud) : null,
        state: () => state, sync, setSource, subscribe: listener => { notify = listener; return release },
      },
    })
  })
  afterEach(async () => { service.dispose(); await rm(root, { recursive: true, force: true }) })

  it('makes cloud data available through existing preset queries and prefers local edits', async () => {
    expect(await service.invoke('listPresets', undefined)).toMatchObject({ ok: true, value: { presets: [
      { id: cloud.id, name: 'Cloud IEM', source: 'cloud', revision: 1 },
    ] } })
    expect(await service.invoke('getPreset', { id: cloud.id })).toMatchObject({ ok: true,
      value: { source: 'cloud', profile: cloud.profile, etag: cloud.etag } })
    const local = structuredClone(cloud.profile)
    local.name = 'My IEM'
    expect((await service.invoke('savePreset', { id: local.id, profile: local })).ok).toBe(true)
    cloud.profile.name = 'Cloud IEM revision 2'; cloud.profile.revision = 2
    cloud.etag = etagFor(cloud.profile)
    expect(await service.invoke('getPreset', { id: local.id })).toEqual({ ok: true,
      value: { profile: local, etag: etagFor(local) } })
    expect(await service.invoke('listPresets', undefined)).toMatchObject({ ok: true,
      value: { presets: [{ id: local.id, name: 'My IEM' }] } })
    expect((await new PresetStore(root).get(local.id))?.profile).toEqual(local)
    expect((await service.invoke('deletePreset', { id: local.id })).ok).toBe(true)
    expect(await service.invoke('getPreset', { id: local.id })).toMatchObject({ ok: true,
      value: { source: 'cloud', profile: { name: 'Cloud IEM revision 2', revision: 2 } } })
  })

  it('does not allow renderer arguments to change the sync source or policy', async () => {
    for (const method of ['getStylePackSyncState', 'syncStylePacks']) {
      for (const args of [{ manifestUrl: 'https://untrusted.invalid/manifest.json' }, {}, null]) {
        expect(await service.invoke(method, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
      }
    }
    expect(sync).not.toHaveBeenCalled()
    expect(await service.invoke('getStylePackSyncState', undefined)).toEqual({ ok: true, value: state })
    expect(await service.invoke('syncStylePacks', undefined)).toEqual({ ok: true, value: state })
    expect(sync).toHaveBeenCalledOnce()
  })

  it('broadcasts updates through the established feature channel and suppresses late events', () => {
    const receive = vi.fn()
    const unsubscribe = service.subscribeFeatures!(receive)
    const event: StylePackSyncEvent = { topic: 'stylepacks-changed', data: { revision: 2 } }
    notify!(event)
    expect(receive).toHaveBeenCalledWith(event)
    service.dispose()
    notify!(event)
    expect(receive).toHaveBeenCalledOnce()
    unsubscribe()
    expect(release).toHaveBeenCalledOnce()
  })

  it('allows only built-in source identifiers and does not refresh implicitly', async () => {
    for (const args of [{ source: 'https://evil.test/manifest.json' }, { source: 'github', publicKey: 'other' }, { source: 'auto' }, null, {}]) {
      expect(await service.invoke('setStylePackSyncSource', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(setSource).not.toHaveBeenCalled()
    expect(await service.invoke('setStylePackSyncSource', { source: 'gitcode' })).toEqual({ ok: true, value: { ...state, source: 'gitcode' } })
    expect(setSource).toHaveBeenCalledExactlyOnceWith('gitcode')
    expect(sync).not.toHaveBeenCalled()
  })
})
