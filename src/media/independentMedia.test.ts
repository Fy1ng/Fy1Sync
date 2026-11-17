import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachHandlers, MediaError } from './hlsController'
import { IndependentMedia } from './independentMedia'

const attached = vi.hoisted(() => ({ calls: [] as Array<{ handlers: AttachHandlers; destroy: ReturnType<typeof vi.fn> }> }))
vi.mock('./hlsController', () => ({ attachMedia: vi.fn(async (_video: HTMLVideoElement, _descriptor: unknown, handlers: AttachHandlers) => {
  const destroy = vi.fn()
  attached.calls.push({ handlers, destroy })
  return { mode: 'hlsjs', destroy, livePosition: () => null, setLevel() {} }
}) }))
const instances: IndependentMedia[] = []
const source = { kind: 'hls' as const, url: '/synthetic.m3u8', input: '/synthetic.m3u8', label: '测试', loop: false, viaProxy: false }
beforeEach(() => { attached.calls.length = 0 })
afterEach(() => { while (instances.length) instances.pop()!.dispose() })

describe('independent media error ownership', () => {
  it('publishes attachment error fields and clears them only on recovery or reload', async () => {
    const media = new IndependentMedia('test')
    instances.push(media)
    const observed = vi.fn()
    const off = media.subscribeErrors(observed)
    await media.load(source)
    const failure: MediaError = { fatal: true, message: '测试载入失败', detail: { type: 'networkError', details: 'fragLoadError', status: 503 } }
    attached.calls[0]!.handlers.onError!(failure)
    expect(media.error()).toBe(failure)
    expect(observed).toHaveBeenLastCalledWith(failure)
    attached.calls[0]!.handlers.onRecovered!()
    expect(media.error()).toBeNull()
    expect(observed).toHaveBeenLastCalledWith(null)
    off()
    observed.mockClear()
    attached.calls[0]!.handlers.onError!(failure)
    expect(observed).not.toHaveBeenCalled()
  })

  it('drops errors and recovery callbacks belonging to a replaced attachment', async () => {
    const media = new IndependentMedia('test')
    instances.push(media)
    const observed = vi.fn()
    media.subscribeErrors(observed)
    await media.load(source)
    await media.load({ ...source, url: '/replacement.m3u8' })
    expect(attached.calls[0]!.destroy).toHaveBeenCalledOnce()
    const failure: MediaError = { fatal: true, message: '新播放失败', detail: { code: 'NEW_MEDIA' } }
    attached.calls[1]!.handlers.onError!(failure)
    observed.mockClear()
    attached.calls[0]!.handlers.onError!({ fatal: true, message: '旧播放失败' })
    attached.calls[0]!.handlers.onRecovered!()
    expect(media.error()).toBe(failure)
    expect(observed).not.toHaveBeenCalled()
    media.dispose()
    attached.calls[1]!.handlers.onError!(failure)
    expect(observed).not.toHaveBeenCalled()
  })
})
