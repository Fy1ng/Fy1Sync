import { describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { youtubeSource } from './youtubeSource'

function bridge(results: Record<string, unknown>) {
  const listeners: Record<string, (value: never) => void> = {}
  const invoke = vi.fn(async (method: string) => results[method] ?? { ok: true, value: { ok: true } })
  const api = {
    invoke, subscribeDanmaku: () => () => {},
    subscribeYtBrowseState: (fn: (value: never) => void) => { listeners.state = fn; return () => {} },
    subscribeYtImportProgress: (fn: (value: never) => void) => { listeners.job = fn; return () => {} },
  } as unknown as StreamSyncerBridge
  return { api, invoke, listeners }
}

describe('youtubeSource', () => {
  it('is absent when main offers no YouTube browsing', () => {
    expect(youtubeSource({ invoke: vi.fn(), subscribeDanmaku: () => () => {} } as unknown as StreamSyncerBridge)).toBeNull()
  })

  it('maps open failures to the panel error words', async () => {
    const { api } = bridge({ ytBrowseOpen: { ok: false, code: 'auth-required', message: '' } })
    expect(await youtubeSource(api)!.open('https://www.youtube.com/watch?v=swMquqtyh-A')).toEqual({ ok: false, error: 'auth-required', detail: { ok: false, code: 'auth-required', message: '' } })
    const other = bridge({ ytBrowseOpen: { ok: false, code: 'internal-error', message: '' } })
    expect(await youtubeSource(other.api)!.open('x')).toEqual({ ok: false, error: 'failed', detail: { ok: false, code: 'internal-error', message: '' } })
  })

  it('maps the pushed state', async () => {
    const { api, listeners } = bridge({ ytBrowseState: { ok: true, value: { videoId: null } } })
    const source = youtubeSource(api)!
    const seen = vi.fn()
    source.subscribe(seen)
    listeners.state!({ videoId: 'swMquqtyh-A', title: 'PGL', duration: 100, currentTime: 5, playing: true,
      videoWidth: 3840, videoHeight: 2160, isAd: true, playerOnly: true, errorCode: null } as never)
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ advert: true, playerOnly: true, videoWidth: 3840, error: null }))
  })

  it('sends the player rectangle to main', async () => {
    const { api, invoke } = bridge({})
    await youtubeSource(api)!.place({ x: 10, y: 20, width: 640, height: 360 }, true)
    expect(invoke).toHaveBeenCalledWith('ytBrowseSetViewport', { rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true })
  })

  it('hands the still pixels over as they came, without decoding', async () => {
    const rgba = new Uint8Array(4 * 2 * 4).fill(7)
    const { api } = bridge({ ytBrowseSnapshot: { ok: true, value: { rgba, videoId: 'swMquqtyh-A', approximateTime: 12.5, approximate: true,
      videoWidth: 4, videoHeight: 2, width: 4, height: 2, isOneToOne: true } } })
    const result = await youtubeSource(api)!.still()
    expect(result).toMatchObject({ ok: true, still: { native: true, videoId: 'swMquqtyh-A', approxTime: 12.5, frame: { width: 4, height: 2, mediaTime: 12.5 } } })
    if (!result.ok) throw new Error('still failed')
    expect(result.still.frame.pixels.buffer).toBe(rgba.buffer)
  })

  it('maps the new still errors', async () => {
    const { api } = bridge({ ytBrowseSnapshot: { ok: false, code: 'origin-tainted', message: '' } })
    expect(await youtubeSource(api)!.still()).toEqual({ ok: false, error: 'origin-tainted', detail: { ok: false, code: 'origin-tainted', message: '' } })
  })

  it.each([2160, 1440, 1080] as const)('passes the requested %sp to main', async (targetHeight) => {
    const { api, invoke } = bridge({ ytImportStart: { ok: true, value: { jobId: 'a' } } })
    expect(await youtubeSource(api)!.startClip('https://www.youtube.com/watch?v=swMquqtyh-A', 750, 930, targetHeight))
      .toEqual({ ok: true, jobId: 'a' })
    expect(invoke).toHaveBeenCalledWith('ytImportStart', { url: 'https://www.youtube.com/watch?v=swMquqtyh-A', startSeconds: 750, endSeconds: 930, targetHeight })
  })

  it('preserves bridge failure fields and rejected exceptions without converting them into an empty result', async () => {
    const failure = { ok: false, code: 'network', message: '下载失败', detail: { status: 502, stderr: 'upstream timeout' } }
    const { api, invoke } = bridge({ ytImportStart: failure })
    const source = youtubeSource(api)!
    expect(await source.startClip('x', 1, 2, 1080)).toMatchObject({ ok: false, error: 'network', detail: failure })
    invoke.mockRejectedValueOnce(Object.assign(new Error('transport closed'), { code: 'IPC_CLOSED' }))
    expect(await source.open('x')).toMatchObject({ ok: false, detail: { code: 'failed', detail: { name: 'Error', message: 'transport closed', code: 'IPC_CLOSED' } } })
  })

  it('reports failed cancellation through the source instance error subscription', async () => {
    const failure = { ok: false, code: 'cancel-failed', message: '取消失败', detail: { jobId: 'job-a', exitCode: 3 } }
    const { api } = bridge({ ytImportCancel: failure })
    const source = youtubeSource(api)!
    const seen = vi.fn()
    const release = source.subscribeErrors!(seen)
    await source.cancelClip('job-a')
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ message: '取消下载失败, 请重试.', detail: failure }))
    release()
  })

  it('restores old ready clips using the format dimensions alone', async () => {
    const { api } = bridge({ ytImportList: { ok: true, value: [{ jobId: 'old', videoId: 'v', startSeconds: 1, endSeconds: 20,
      state: 'ready', format: { width: 2560, height: 1440 }, mediaUrl: 'app://app/admin-media/old' }] } })
    const seen = vi.fn()
    youtubeSource(api)!.subscribeClips(seen)
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith([expect.objectContaining({ jobId: 'old', state: 'ready',
      width: 2560, height: 1440, targetHeight: undefined, mediaUrl: 'app://app/admin-media/old' })]))
  })

  it('turns import jobs into panel jobs with 0..1 progress', async () => {
    const { api, listeners } = bridge({ ytImportList: { ok: true, value: [] } })
    const seen = vi.fn()
    youtubeSource(api)!.subscribeClips(seen)
    listeners.job!({ jobId: 'a', videoId: 'v', startSeconds: 1, endSeconds: 20, targetHeight: 1440, state: 'downloading',
      progress: { downloadedBytes: 5, totalBytes: 10, percent: 50 } } as never)
    expect(seen).toHaveBeenLastCalledWith([expect.objectContaining({ jobId: 'a', progress: 0.5, title: '', targetHeight: 1440 })])
    listeners.job!({ jobId: 'a', videoId: 'v', startSeconds: 1, endSeconds: 20, targetHeight: 1440, state: 'failed',
      error: { code: 'format-unavailable', message: '' } } as never)
    expect(seen).toHaveBeenLastCalledWith([expect.objectContaining({ state: 'failed', error: 'format-unavailable', progress: null, targetHeight: 1440 })])
  })
})
