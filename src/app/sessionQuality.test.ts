import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { apiClient } from './apiClient'
import { primeMediaElement } from '../test/setup'
import type { MediaDescriptor } from '../core/types'

let session: Session
beforeEach(() => vi.useFakeTimers())
afterEach(() => { session?.dispose(); vi.useRealTimers() })

async function harness(_profile: boolean) {
  session = new Session({ createSampler: () => null })
  const source: MediaDescriptor = { kind: 'progressive', url: 'app://app/buffer/old.mp4', label: '直播', input: 'https://page.invalid',
    viaProxy: false, loop: false, sourceQuality: 'high', sourceQualities: [{ id: 'high', label: '高清' }, { id: 'low', label: '流畅' }] }
  await session.loadSource('official', source)
  await session.loadSource('commentary', { ...source, sourceQuality: undefined, sourceQualities: undefined })
  for (const role of ['official', 'commentary'] as const) primeMediaElement(session.engine.element(role), { duration: 600, currentTime: 100 })
  await session.applyOffset(5)
  session.autoSync.authorize()
  await session.engine.setPlaying(true)
  const switchQuality = vi.spyOn(apiClient, 'switchQuality').mockResolvedValue({ ok: true, value: { ok: true, stream: {
    platform: 'youtube', kind: 'progressive', url: 'app://app/buffer/new.mp4', label: '新画质', channel: 'id', requiresProxy: false,
    quality: 'low', qualities: source.sourceQualities,
  } } })
  const sync = vi.spyOn(session.autoSync, 'run').mockResolvedValue({ applied: true } as any)
  return { switchQuality, sync }
}

describe('quality restart synchronization', () => {
  it('does not reauthorize or automatically align after manual adjustment', async () => {
    const h = await harness(true)
    await session.applyOffset(4)
    const authorize = vi.spyOn(session.autoSync, 'authorize')
    await session.changeSourceQuality('official', 'low')
    expect(h.sync).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(session.autoSync.autoApplyAuthorized).toBe(false)
  })
  it('resets that role rewind and synchronizes exactly once after a successful switch', async () => {
    const h = await harness(true)
    await session.changeSourceQuality('official', 'low')
    expect(h.switchQuality).toHaveBeenCalledWith('official', 'low')
    expect(session.flush().appliedRewind.official).toBe(0)
    expect(session.flush().media.official.descriptor?.sourceQuality).toBe('low')
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(session.engine.element('official').paused).toBe(false)
  })

  it('re-syncs in frame matching mode after both sources are ready', async () => {
    const h = await harness(false)
    await session.changeSourceQuality('official', 'low')
    expect(session.profileFor('official')).toBeNull()
    expect(session.snapshot.autoSync.ready).toBe(true)
    expect(h.sync).toHaveBeenCalledTimes(1)
  })

  it('suppresses duplicate requests and discards a late response after unloading', async () => {
    const h = await harness(true)
    let settle!: (result: any) => void
    h.switchQuality.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    const pending = session.changeSourceQuality('official', 'low')
    await session.changeSourceQuality('official', 'low')
    session.unloadSource('official')
    settle({ ok: true, value: { ok: true, stream: {} } })
    await pending
    expect(h.switchQuality).toHaveBeenCalledTimes(1)
    expect(session.engine.getState().official.descriptor).toBeNull()
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('offers immediate sync when the automatic attempt fails', async () => {
    const h = await harness(true)
    h.sync.mockResolvedValue({ applied: false } as any)
    await session.changeSourceQuality('official', 'low')
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(session.flush().notices[0]?.text).toContain('点击「自动对齐」')
  })

  it('does not direct a single source to automatic alignment after changing quality', async () => {
    const h = await harness(true)
    session.unloadSource('commentary')
    await session.changeSourceQuality('official', 'low')
    expect(session.flush().notices[0]?.text).toBe('画质已切换')
    expect(h.sync).not.toHaveBeenCalled()
  })

  it('preserves pause and suggests sync after playback resumes', async () => {
    const h = await harness(true)
    await session.engine.setPlaying(false)
    await session.changeSourceQuality('official', 'low')
    expect(session.engine.element('official').paused).toBe(true)
    expect(h.sync).not.toHaveBeenCalled()
    expect(session.flush().notices[0]?.text).toContain('恢复两路播放')
  })
})


it('keeps the confirmed video room and raw input through quality replacement', async () => {
  const h = await harness(false)
  const old = session.engine.getState().official.descriptor!
  await session.loadSource('official', { ...old, platform: 'douyu', input: '6657', sourceRoom: '6979222' })
  h.switchQuality.mockResolvedValueOnce({ ok: true, value: { ok: true, stream: {
    platform: 'douyu', channel: '6979222', sourceRoom: '6979222', danmakuRoom: '6979222', kind: 'progressive', label: '斗鱼 6979222',
    url: 'app://app/media/quality', requiresProxy: false, quality: 'low', qualities: old.sourceQualities,
  } } })
  await session.changeSourceQuality('official', 'low')
  expect(session.engine.getState().official.descriptor).toMatchObject({ input: '6657', sourceRoom: '6979222' })
})
