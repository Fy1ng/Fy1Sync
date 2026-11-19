import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import { apiClient } from '../app/apiClient'
import { LAST_SOURCES_STORAGE_KEY, loadLastSources, saveLastSources } from '../app/lastSources'
import type { MediaDescriptor, SourceRole } from '../core/types'
import { Intake } from './Intake'
import { SourceLoaderProvider, useSourceLoader } from './sources'
import type { PlatformKind } from '../../server/platforms/types'

const sessions: Session[] = []
const saved = { official: { input: 'https://live.bilibili.com/100', platform: 'bilibili' as const, label: '官方直播' },
  commentary: { input: 'https://live.douyin.com/200', platform: 'douyin' as const, label: '解说直播' } }
beforeEach(() => {
  localStorage.removeItem(LAST_SOURCES_STORAGE_KEY)
  vi.stubGlobal('streamSyncer', { invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })), subscribeDanmaku: () => () => {} })
})
afterEach(() => { cleanup(); sessions.splice(0).forEach(session => session.dispose()); localStorage.removeItem(LAST_SOURCES_STORAGE_KEY); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const session = new Session({ createSampler: () => null }); sessions.push(session)
  let loader!: ReturnType<typeof useSourceLoader>
  function Reader() { loader = useSourceLoader(); return null }
  const onClose = vi.fn()
  render(<SessionProvider session={session}><SourceLoaderProvider><Reader /><Intake onClose={onClose} onSchedule={() => {}} pendingFile={null} /></SourceLoaderProvider></SessionProvider>)
  return { session, onClose, get loader() { return loader } }
}
function resolver() {
  return vi.spyOn(apiClient, 'resolve').mockImplementation(async (_input, platform) => ({ ok: true, value: { ok: true, stream: {
    platform: platform as PlatformKind, kind: 'progressive', url: '/test-sources/commentary.mp4', label: '已恢复', channel: '100', requiresProxy: false,
  } } }))
}

describe('one-click source restoration', () => {
  it('restores each saved role through fresh platform resolution and does not run until clicked', async () => {
    saveLastSources(saved)
    const f = fixture(), resolve = resolver()
    const load = vi.spyOn(f.session, 'loadSource').mockResolvedValue()
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '恢复上次' }))
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(resolve).toHaveBeenCalledWith(saved.official.input, 'bilibili', 'official', undefined, true)
    expect(resolve).toHaveBeenCalledWith(saved.commentary.input, 'douyin', 'commentary', undefined, true)
    await waitFor(() => expect(load).toHaveBeenCalledWith('official', expect.objectContaining({ platform: 'bilibili' })))
    await waitFor(() => expect(load).toHaveBeenCalledWith('commentary', expect.objectContaining({ platform: 'douyin' })))
    await waitFor(() => expect(f.onClose).toHaveBeenCalled())
  })

  it('retains successful history and shows the failed role when upstream resolution fails', async () => {
    saveLastSources(saved)
    const f = fixture()
    vi.spyOn(f.session, 'loadSource').mockResolvedValue()
    resolver().mockImplementation(async (_input, platform) => platform === 'douyin' ? { ok: true, value: { ok: false, failure: { code: 'not-live', message: '该直播间未开播' } } }
      : { ok: true, value: { ok: true, stream: { platform: platform as PlatformKind, kind: 'progressive', url: '/test-sources/official.mp4', label: '官方', channel: '100', requiresProxy: false } } })
    fireEvent.click(screen.getByRole('button', { name: '恢复上次' }))
    await screen.findByText('解说：该直播间未开播')
    expect(loadLastSources()).toEqual(saved)
    expect(f.onClose).not.toHaveBeenCalled()
  })

  it('records only ready sources and preserves the prior slot after a failed replacement', async () => {
    saveLastSources(saved)
    const f = fixture()
    const descriptor: MediaDescriptor = { input: 'https://www.twitch.tv/newroom', platform: 'twitch', kind: 'progressive',
      url: '/test-sources/official.mp4', label: '新画面', loop: false, viaProxy: false }
    await act(() => f.session.loadSource('official', descriptor))
    expect(loadLastSources().official).toEqual(saved.official)
    const video = f.session.engine.element('official')
    await act(async () => {
      Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
      video.dispatchEvent(new Event('loadedmetadata'))
    })
    await waitFor(() => expect(loadLastSources().official?.input).toBe(descriptor.input))
    expect(loadLastSources().commentary).toEqual(saved.commentary)
  })

  it('does not overwrite an already loaded role, and disables restoration without history', async () => {
    const f = fixture()
    expect(screen.getByRole('button', { name: '恢复上次' })).toBeDisabled()
    cleanup(); f.session.dispose(); sessions.splice(0)
    saveLastSources(saved)
    const current = fixture()
    const descriptor: MediaDescriptor = { input: saved.official.input, platform: 'bilibili', kind: 'progressive',
      url: '/test-sources/official.mp4', label: '当前画面', loop: false, viaProxy: false }
    await act(() => current.session.loadSource('official', descriptor))
    const resolve = resolver()
    vi.spyOn(current.session, 'loadSource').mockResolvedValue()
    await act(() => current.loader.restorePrevious())
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[2]).toBe('commentary' satisfies SourceRole)
  })
})
