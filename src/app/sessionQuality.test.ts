import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { apiClient } from './apiClient'
import { primeMediaElement } from '../test/setup'
import { createEmptyProfile } from '../core/profileSchema'
import type { MediaDescriptor } from '../core/types'

let session: Session
afterEach(() => session?.dispose())

async function harness(profile: boolean) {
  session = new Session({ createSampler: () => null })
  const source: MediaDescriptor = { kind: 'progressive', url: 'app://app/buffer/old.mp4', label: '直播', input: 'https://page.invalid',
    viaProxy: false, loop: false, sourceQuality: 'high', sourceQualities: [{ id: 'high', label: '高清' }, { id: 'low', label: '流畅' }] }
  await session.loadSource('official', source)
  await session.loadSource('commentary', { ...source, sourceQuality: undefined, sourceQualities: undefined })
  for (const role of ['official', 'commentary'] as const) primeMediaElement(session.engine.element(role), { duration: 600, currentTime: 100 })
  await session.applyOffset(5)
  await session.engine.setPlaying(true)
  if (profile) session.setProfileForAll(createEmptyProfile('test', 'Test'))
  const switchQuality = vi.spyOn(apiClient, 'switchQuality').mockResolvedValue({ ok: true, value: { ok: true, stream: {
    platform: 'youtube', kind: 'progressive', url: 'app://app/buffer/new.mp4', label: '新画质', channel: 'id', requiresProxy: false,
    quality: 'low', qualities: source.sourceQualities,
  } } })
  const sync = vi.spyOn(session, 'syncNow').mockResolvedValue({ applied: true } as any)
  return { switchQuality, sync }
}

describe('quality restart synchronization', () => {
  it('resets that role rewind and synchronizes exactly once after a successful switch', async () => {
    const h = await harness(true)
    await session.changeSourceQuality('official', 'low')
    expect(h.switchQuality).toHaveBeenCalledWith('official', 'low')
    expect(session.flush().appliedRewind.official).toBe(0)
    expect(session.flush().media.official.descriptor?.sourceQuality).toBe('low')
    expect(h.sync).toHaveBeenCalledTimes(1)
    expect(session.engine.element('official').paused).toBe(false)
  })

  it('keeps a profile accepted this session and re-syncs with it after a switch', async () => {
    const h = await harness(false)
    // An auto-learned candidate the user pressed 使用 on carries a `session/` id.
    const accepted = { ...createEmptyProfile('session/official', '自动学习'), roi: { x: 0.48, y: 0.03, w: 0.03, h: 0.03 } }
    session.setProfile('official', accepted)
    await session.changeSourceQuality('official', 'low')
    expect(session.profileFor('official')).toBe(accepted)
    expect(h.sync).toHaveBeenCalledTimes(1)
  })

  it('drops a session profile when a different source is loaded', async () => {
    await harness(false)
    session.setProfile('official', createEmptyProfile('session/official', '自动学习'))
    await session.loadSource('official', { kind: 'progressive', url: 'app://app/media/other', label: '另一场', input: 'x',
      viaProxy: false, loop: false })
    expect(session.profileFor('official')).toBeNull()
  })

  it('suggests immediate sync when no profile is selected', async () => {
    const h = await harness(false)
    await session.changeSourceQuality('official', 'low')
    expect(h.sync).not.toHaveBeenCalled()
    expect(session.flush().notices.some((notice) => notice.text.includes('立即同步'))).toBe(true)
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
    expect(session.flush().notices.some((notice) => notice.text.includes('立即同步'))).toBe(true)
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
