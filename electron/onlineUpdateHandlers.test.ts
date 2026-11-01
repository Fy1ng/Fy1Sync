import { describe, expect, it, vi } from 'vitest'
import { FeatureApi } from '../server/featureApi'
import { createOnlineUpdateHandlers } from './onlineUpdateHandlers'
import type { OnlineUpdateState } from './onlineUpdateContracts'

function fixture() {
  const item = { phase: 'ready' as const, version: '0.3.0', revision: 2, notes: '', downloadedBytes: 1024, totalBytes: 1024, message: '' }
  const state: OnlineUpdateState = { phase: 'idle', source: 'github', availableSources: ['github', 'gitcode'], currentAppVersion: '0.2.0',
    currentFrontendRevision: 1, bridgeVersion: 1, checkedAt: null, canRollbackFrontend: true, message: '', frontend: item, application: item }
  const options = { service: { state: vi.fn(() => state), setSource: vi.fn(() => state), check: vi.fn(async () => state),
    download: vi.fn(async () => state), cancel: vi.fn(async () => state) },
  isPrimary: (id: number | undefined) => id === 1, apply: vi.fn(async () => false), rollback: vi.fn(async () => false), healthy: vi.fn(() => true) }
  const api = new FeatureApi(createOnlineUpdateHandlers(options))
  return { options, state, call: (method: string, args: unknown = undefined, senderId = 1) => api.invoke(method, args, { senderId }) }
}

describe('online update IPC boundary', () => {
  it.each(['getOnlineUpdateState', 'setOnlineUpdateSource', 'checkOnlineUpdate', 'downloadOnlineUpdate', 'cancelOnlineUpdate', 'applyOnlineUpdate', 'rollbackFrontendUpdate', 'reportFrontendReady'])('rejects non-primary window %s', async method => {
    const f = fixture()
    expect(await f.call(method, undefined, 2)).toMatchObject({ ok: false, code: 'forbidden' })
    expect(f.options.apply).not.toHaveBeenCalled()
    expect(f.options.service.download).not.toHaveBeenCalled()
  })
  it.each([
    ['getOnlineUpdateState', {}], ['checkOnlineUpdate', { url: 'https://bad.example/' }], ['setOnlineUpdateSource', { source: 'other' }],
    ['setOnlineUpdateSource', { source: 'github', publicKey: 'evil' }], ['downloadOnlineUpdate', { kind: 'frontend', path: 'malware.exe' }],
    ['downloadOnlineUpdate', { kind: 'arbitrary' }], ['applyOnlineUpdate', { kind: 'application', url: 'evil' }],
    ['reportFrontendReady', { bridgeVersion: -1 }], ['reportFrontendReady', { bridgeVersion: 1, ready: true }],
    ['cancelOnlineUpdate', null], ['rollbackFrontendUpdate', { target: '../../outside' }],
  ])('rejects arbitrary data for %s', async (method, args) => {
    expect(await fixture().call(method as string, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })
  it('downloads without asking to apply or executing a file, and allows cancellation', async () => {
    const f = fixture()
    expect(await f.call('downloadOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: true })
    expect(await f.call('cancelOnlineUpdate')).toMatchObject({ ok: true })
    expect(f.options.service.download).toHaveBeenCalledWith('frontend')
    expect(f.options.apply).not.toHaveBeenCalled()
    expect(f.options.rollback).not.toHaveBeenCalled()
  })
  it('holds mutations during native confirmation and releases them when declined', async () => {
    const f = fixture()
    let confirm!: (accepted: boolean) => void
    f.options.apply.mockImplementation(() => new Promise(resolve => { confirm = resolve }))
    const first = f.call('applyOnlineUpdate', { kind: 'frontend' })
    expect(await f.call('applyOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await f.call('downloadOnlineUpdate', { kind: 'application' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await f.call('setOnlineUpdateSource', { source: 'gitcode' })).toMatchObject({ ok: false, code: 'busy' })
    expect(await f.call('getOnlineUpdateState')).toMatchObject({ ok: true })
    confirm(false)
    expect(await first).toMatchObject({ ok: true, value: { accepted: false } })
    expect(await f.call('checkOnlineUpdate')).toMatchObject({ ok: true })
  })
  it('never applies an incomplete update or rolls back without an available target', async () => {
    const f = fixture()
    f.state.frontend = { ...f.state.frontend, phase: 'downloading' }
    f.state.canRollbackFrontend = false
    expect(await f.call('applyOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: false, code: 'busy' })
    f.state.frontend = { ...f.state.frontend, phase: 'available' }
    expect(await f.call('rollbackFrontendUpdate')).toMatchObject({ ok: false, code: 'not-available' })
    expect(f.options.apply).not.toHaveBeenCalled()
  })
})
