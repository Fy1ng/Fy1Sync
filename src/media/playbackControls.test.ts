import { describe, expect, it, vi } from 'vitest'
import { latestPlayableTime, PlaybackControls } from './playbackControls'
import { IndependentMedia } from './independentMedia'

function fixture(livePosition: () => number | null = () => null) {
  const video = document.createElement('video')
  let time = 120
  Object.defineProperties(video, {
    currentTime: { configurable: true, get: () => time, set: (value: number) => { time = value; video.dispatchEvent(new Event('seeked')) } },
    duration: { configurable: true, get: () => Infinity }, readyState: { configurable: true, get: () => 4 },
    seekable: { configurable: true, get: () => ({ length: 1, start: () => 100, end: () => 150 }) },
    videoWidth: { configurable: true, get: () => 1280 },
  })
  return { video, controls: new PlaybackControls(video, () => true, 50, livePosition) }
}
describe('where 回到直播 lands', () => {
  const live = { kind: 'live', seekableStart: 100, seekableEnd: 150 } as const
  it('takes the hls.js sync point, a few segments behind the newest frame', () => {
    expect(latestPlayableTime(live, 144.2)).toBe(144.2)
  })
  it('stays three local segments back without one, never at the newest frame', () => {
    expect(latestPlayableTime(live)).toBe(144)
    expect(latestPlayableTime(live, Number.NaN)).toBe(144)
  })
  it('keeps inside the reachable window', () => {
    expect(latestPlayableTime(live, 151)).toBe(150)
    expect(latestPlayableTime({ kind: 'live', seekableStart: 100, seekableEnd: 103 })).toBe(100)
    expect(latestPlayableTime({ kind: 'vod', duration: 600 }, 590)).toBeNull()
  })
})
describe('headless playback controls', () => {
  it('clamps relative seeks and returns to live without remounting', async () => {
    const { video, controls } = fixture()
    expect(await controls.seekBy(-50)).toMatchObject({ ok: true, target: 100, clamped: true })
    expect(await controls.seekBy(20)).toMatchObject({ ok: true, target: 120, clamped: false })
    expect(await controls.returnToLive()).toMatchObject({ ok: true, target: 144 })
    expect(video.currentTime).toBe(144)
    controls.dispose()
  })
  it('returns to the sync point its attachment reports', async () => {
    const { video, controls } = fixture(() => 143.5)
    expect(await controls.returnToLive()).toMatchObject({ ok: true, target: 143.5 })
    expect(video.currentTime).toBe(143.5)
    controls.dispose()
  })
  it('does not claim completion for an unconfirmed seek and cancels on dispose', async () => {
    const { video, controls } = fixture()
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 120, set: () => {} })
    const pending = controls.seekBy(-5)
    controls.dispose()
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(await controls.seekBy(5)).toMatchObject({ ok: false, reason: 'unavailable' })
  })
  it('reports native PiP capability and transient activation errors accurately', async () => {
    const { video, controls } = fixture()
    expect(await controls.toggleNativePip()).toMatchObject({ ok: false, reason: 'unsupported' })
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true })
    video.requestPictureInPicture = vi.fn(async () => { throw new DOMException('gesture', 'NotAllowedError') })
    expect(await controls.toggleNativePip()).toMatchObject({ ok: false, reason: 'user-gesture-required' })
    expect(video.requestPictureInPicture).toHaveBeenCalledTimes(1)
    delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled
    controls.dispose()
  })
  it('keeps independent video identity when Claude moves its mount', () => {
    const media = new IndependentMedia('stream-test')
    const one = document.createElement('div'); const two = document.createElement('div')
    const video = media.video
    media.mount(one); media.mount(two)
    expect(two.firstChild).toBe(video)
    expect(one.childElementCount).toBe(0)
    media.dispose()
    expect(two.childElementCount).toBe(0)
  })
})
