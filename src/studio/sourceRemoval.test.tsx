import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { apiClient } from '../app/apiClient'
import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { MediaDescriptor } from '../core/types'
import { SourceLoaderProvider, useSourceLoader } from './sources'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const sessions: Session[] = []
const descriptor: MediaDescriptor = { kind: 'test', url: '/test-sources/commentary.mp4', input: 'old-room', label: 'old commentary', loop: false, viaProxy: false }
const stopped = { ok: true as const, value: { ok: true as const } }

async function fixture() {
  const session = new Session({ createSampler: () => null })
  sessions.push(session)
  await session.loadSource('commentary', descriptor)
  session.connectDanmaku('288016')
  let loader!: ReturnType<typeof useSourceLoader>
  function Controls() { loader = useSourceLoader(); return null }
  render(<SessionProvider session={session}><SourceLoaderProvider><Controls /></SourceLoaderProvider></SessionProvider>)
  const connect = vi.spyOn(session, 'connectDanmaku')
  const play = vi.spyOn(session, 'setPlaying')
  return { session, connect, play, get loader() { return loader } }
}
beforeEach(() => {
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})
afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('commentary source removal races', () => {
  it.each(['douyu', 'huya'] as const)('does not reconnect %s chat when removal overtakes a resolved source still loading', async platform => {
    const f = await fixture()
    const attachment = deferred<Awaited<ReturnType<typeof apiClient.stopBuffer>>>()
    const stop = vi.spyOn(apiClient, 'stopBuffer').mockReturnValueOnce(attachment.promise).mockResolvedValue(stopped)
    vi.spyOn(apiClient, 'resolve').mockResolvedValue({ ok: true, value: { ok: true, stream: {
      platform, kind: 'progressive', url: '/test-sources/new.mp4', label: 'new room', channel: '660000',
      sourceRoom: '660000', danmakuRoom: '660000', requiresProxy: false,
    } } })
    let loading!: Promise<boolean>
    act(() => { loading = f.loader.loadInput('commentary', '660000', platform) })
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    act(() => f.session.unloadSource('commentary'))
    await act(async () => { attachment.resolve(stopped); expect(await loading).toBe(false) })
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.play).not.toHaveBeenCalled()
    expect(f.session.flush()).toMatchObject({ media: { commentary: { status: 'empty' } }, danmaku: { room: null } })
    expect(f.loader.state.commentary.busy).toBe(false)
  })

  it('does not reconnect restored Huya chat after its descriptor load was removed', async () => {
    const f = await fixture()
    const attachment = deferred<Awaited<ReturnType<typeof apiClient.stopBuffer>>>()
    const stop = vi.spyOn(apiClient, 'stopBuffer').mockReturnValueOnce(attachment.promise).mockResolvedValue(stopped)
    let loading!: Promise<void>
    act(() => { loading = f.loader.loadDescriptor('commentary', { ...descriptor, platform: 'huya', sourceRoom: '660000' }) })
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    act(() => f.session.unloadSource('commentary'))
    await act(async () => { attachment.resolve(stopped); await loading })
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.play).not.toHaveBeenCalled()
    expect(f.session.flush().danmaku.room).toBeNull()
  })

  it('keeps a newer load busy and connects only its room when an older load completes late', async () => {
    const f = await fixture()
    const first = deferred<Awaited<ReturnType<typeof apiClient.stopBuffer>>>()
    const second = deferred<Awaited<ReturnType<typeof apiClient.stopBuffer>>>()
    const stop = vi.spyOn(apiClient, 'stopBuffer').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(stopped)
    let older!: Promise<void>, newer!: Promise<void>
    act(() => { older = f.loader.loadDescriptor('commentary', { ...descriptor, platform: 'huya', sourceRoom: '111111' }) })
    act(() => { newer = f.loader.loadDescriptor('commentary', { ...descriptor, platform: 'huya', sourceRoom: '222222' }) })
    expect(stop).toHaveBeenCalledTimes(2)
    await act(async () => { first.resolve(stopped); await older })
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.loader.state.commentary.busy).toBe(true)
    await act(async () => { second.resolve(stopped); await newer })
    expect(f.connect).toHaveBeenCalledExactlyOnceWith('huya:222222')
    expect(f.loader.state.commentary.busy).toBe(false)
    expect(f.session.flush().danmaku.room).toBe('huya:222222')
  })

  it('does not start the media attachment or chat when removal happens during resolution', async () => {
    const f = await fixture()
    const resolution = deferred<Awaited<ReturnType<typeof apiClient.resolve>>>()
    vi.spyOn(apiClient, 'resolve').mockReturnValue(resolution.promise)
    const attach = vi.spyOn(f.session, 'loadSource')
    let loading!: Promise<boolean>
    act(() => { loading = f.loader.loadInput('commentary', '660000', 'douyu') })
    act(() => f.session.unloadSource('commentary'))
    await act(async () => {
      resolution.resolve({ ok: true, value: { ok: true, stream: {
        platform: 'douyu', kind: 'progressive', url: '/test-sources/new.mp4', label: 'new room',
        channel: '660000', danmakuRoom: '660000', requiresProxy: false,
      } } })
      expect(await loading).toBe(false)
    })
    expect(attach).not.toHaveBeenCalled()
    expect(f.connect).not.toHaveBeenCalled()
    expect(f.session.flush().danmaku.room).toBeNull()
  })
})
