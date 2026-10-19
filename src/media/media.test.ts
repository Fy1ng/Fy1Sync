import { afterEach, describe, expect, it } from 'vitest'

import type { MediaDescriptor, Timebase } from '../core/types'
import { attachMedia, hlsLoader, translateHlsError, type MediaError } from './hlsController'
import { activeQualityLabel, AUTO_QUALITY, describeLevels } from './quality'
import {
  clampSeek,
  isNearLiveEdge,
  lastSeekableRange,
  latencyBehindEdge,
  liveEdge,
  planRewind,
  readTimebase,
  seekCeiling,
  seekFloor,
  seekReached,
  windowSeconds,
} from './timebase'

function ranges(...pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (index: number) => pairs[index]?.[0] ?? 0,
    end: (index: number) => pairs[index]?.[1] ?? 0,
  } as TimeRanges
}

describe('lastSeekableRange', () => {
  it('returns null with no ranges', () => {
    expect(lastSeekableRange(ranges())).toBeNull()
  })

  it('uses the last range when the stream has gaps', () => {
    expect(lastSeekableRange(ranges([0, 5], [90, 150]))).toEqual({ start: 90, end: 150 })
  })

  it('rejects a zero-length or reversed range', () => {
    expect(lastSeekableRange(ranges([10, 10]))).toBeNull()
    expect(lastSeekableRange(ranges([10, 5]))).toBeNull()
  })

  it('rejects an infinite end', () => {
    expect(lastSeekableRange(ranges([0, Number.POSITIVE_INFINITY]))).toBeNull()
  })
})

describe('readTimebase', () => {
  it('reads a VOD from its duration', () => {
    expect(readTimebase({ duration: 600, seekable: ranges([0, 600]) })).toEqual({
      kind: 'vod',
      duration: 600,
    })
  })

  it('treats an infinite duration as live', () => {
    expect(
      readTimebase({ duration: Number.POSITIVE_INFINITY, seekable: ranges([120, 300]) }),
    ).toEqual({ kind: 'live', seekableStart: 120, seekableEnd: 300 })
  })

  it('treats an implausibly long duration as live', () => {
    const timebase = readTimebase({ duration: 9_000_000, seekable: ranges([100, 400]) })
    expect(timebase?.kind).toBe('live')
  })

  it('honours an explicit live hint over a finite duration', () => {
    const timebase = readTimebase({ duration: 300, seekable: ranges([10, 300]) }, true)
    expect(timebase).toEqual({ kind: 'live', seekableStart: 10, seekableEnd: 300 })
  })

  it('honours an explicit VOD hint over an infinite duration', () => {
    const timebase = readTimebase(
      { duration: Number.POSITIVE_INFINITY, seekable: ranges([0, 100]) },
      false,
    )
    // Duration is unusable, so it falls back to the seekable window.
    expect(timebase).toEqual({ kind: 'live', seekableStart: 0, seekableEnd: 100 })
  })

  it('returns null when nothing is known yet', () => {
    expect(readTimebase({ duration: Number.NaN, seekable: ranges() })).toBeNull()
  })

  it('falls back to the seekable window before duration arrives', () => {
    expect(readTimebase({ duration: 0, seekable: ranges([0, 12]) })).toEqual({
      kind: 'live',
      seekableStart: 0,
      seekableEnd: 12,
    })
  })
})

const vod: Timebase = { kind: 'vod', duration: 600 }
const live: Timebase = { kind: 'live', seekableStart: 100, seekableEnd: 400 }

describe('seek bounds', () => {
  it('bounds a VOD by 0 and duration', () => {
    expect(seekFloor(vod)).toBe(0)
    expect(seekCeiling(vod)).toBe(600)
    expect(windowSeconds(vod)).toBe(600)
  })

  it('bounds a live stream by its DVR window', () => {
    expect(seekFloor(live)).toBe(100)
    expect(seekCeiling(live)).toBe(400)
    expect(liveEdge(live)).toBe(400)
    expect(windowSeconds(live)).toBe(300)
  })

  it('clamps below the floor and reports the shortfall', () => {
    expect(clampSeek(40, live)).toEqual({ target: 100, clamped: true, shortfall: 60 })
  })

  it('clamps above the ceiling', () => {
    expect(clampSeek(700, vod)).toEqual({ target: 600, clamped: true, shortfall: 100 })
  })

  it('passes an in-range target through untouched', () => {
    expect(clampSeek(250, live)).toEqual({ target: 250, clamped: false, shortfall: 0 })
  })
})

describe('planRewind', () => {
  it('plans a rewind that fits', () => {
    expect(planRewind(390, 30, live)).toEqual({ target: 360, clamped: false, shortfall: 0 })
  })

  it('reports how much of a rewind the DVR window cannot cover', () => {
    // 60 s requested from 130 s, but only 30 s of window remain behind it.
    const plan = planRewind(130, 60, live)
    expect(plan.target).toBe(100)
    expect(plan.clamped).toBe(true)
    expect(plan.shortfall).toBeCloseTo(30, 6)
  })

  it('handles a forward move (negative rewind)', () => {
    expect(planRewind(200, -50, live)).toEqual({ target: 250, clamped: false, shortfall: 0 })
  })
})

describe('live edge helpers', () => {
  it('treats a playhead within tolerance as live', () => {
    expect(isNearLiveEdge(399, live)).toBe(true)
    expect(isNearLiveEdge(390, live)).toBe(false)
  })

  it('measures latency behind the edge', () => {
    expect(latencyBehindEdge(370, live)).toBe(30)
    expect(latencyBehindEdge(500, live)).toBe(0)
    expect(latencyBehindEdge(100, vod)).toBe(0)
  })

  it('accepts a seek that landed within a fragment boundary', () => {
    expect(seekReached(120.02, 120)).toBe(true)
    expect(seekReached(120.4, 120)).toBe(false)
  })
})

describe('describeLevels', () => {
  it('puts 自动 first and sorts the rest highest quality first', () => {
    const options = describeLevels([
      { height: 480, width: 854, bitrate: 1_200_000 },
      { height: 1080, width: 1920, bitrate: 6_000_000 },
      { height: 720, width: 1280, bitrate: 3_000_000 },
    ])
    expect(options[0]).toEqual(AUTO_QUALITY)
    expect(options.map((option) => option.label)).toEqual(['自动', '1080p', '720p', '480p'])
    expect(options[1]?.level).toBe(1)
  })

  it('falls back to a name, then to bitrate', () => {
    const options = describeLevels([{ name: '原画' }, { bitrate: 800_000 }])
    expect(options.map((option) => option.label)).toEqual(['自动', '原画', '800 kbps'])
  })

  it('disambiguates two levels with the same height', () => {
    const options = describeLevels([
      { height: 720, width: 1280, bitrate: 3_000_000 },
      { height: 720, width: 1280, bitrate: 1_500_000 },
    ])
    expect(options[1]?.label).not.toBe(options[2]?.label)
    expect(options[1]?.label).toContain('720p')
  })

  it('labels an unknown level rather than dropping it', () => {
    const options = describeLevels([{}])
    expect(options[1]).toMatchObject({ level: 0, label: '未知' })
  })

  it('returns only 自动 for an empty level list', () => {
    expect(describeLevels([])).toEqual([AUTO_QUALITY])
  })
})

describe('activeQualityLabel', () => {
  const options = describeLevels([
    { height: 480, bitrate: 1_000_000 },
    { height: 1080, bitrate: 6_000_000 },
  ])

  it('names the pinned level', () => {
    expect(activeQualityLabel(options, 1, 1)).toBe('1080p')
  })

  it('shows what automatic selected', () => {
    expect(activeQualityLabel(options, -1, 0)).toBe('自动 (480p)')
  })

  it('degrades gracefully when the level is unknown', () => {
    expect(activeQualityLabel(options, 9, 9)).toBe('未知')
    expect(activeQualityLabel(options, -1, 9)).toBe('自动')
  })
})

const FakeHls = {
  ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' },
} as unknown as Parameters<typeof translateHlsError>[0]

describe('translateHlsError', () => {
  const translate = (data: Parameters<typeof translateHlsError>[1]): MediaError =>
    translateHlsError(FakeHls, data)

  it('explains an expired playback URL', () => {
    const error = translate({
      fatal: true,
      type: 'networkError',
      details: 'manifestLoadError',
      response: { code: 403 },
    })
    expect(error.message).toContain('403')
    expect(error.hint).toContain('有效期')
  })

  it('explains a missing playlist', () => {
    const error = translate({ fatal: true, type: 'networkError', details: 'manifestParsingError' })
    expect(error.message).toContain('播放列表')
    expect(error.hint).toContain('代理')
  })

  it('reports other network errors with their detail', () => {
    const error = translate({ fatal: false, type: 'networkError', details: 'fragLoadTimeOut' })
    expect(error.message).toContain('fragLoadTimeOut')
    expect(error.fatal).toBe(false)
  })

  it('reports media errors as decode problems', () => {
    const error = translate({ fatal: true, type: 'mediaError', details: 'bufferStalledError' })
    expect(error.message).toContain('解码错误')
    expect(error.hint).toContain('恢复')
  })

  it('falls through for unknown error types', () => {
    const error = translate({ fatal: true, type: 'otherError', details: 'keySystemNoKeys' })
    expect(error.message).toContain('播放器错误')
  })
})

describe('attachMedia HLS precedence', () => {
  /** Just enough hls.js for `attachMedia` to wire itself up. */
  function fakeModule(supported: boolean): { module: unknown; instances: number; configs: unknown[] } {
    const counter = { instances: 0 }
    const configs: unknown[] = []
    class FakeInstance {
      levels: unknown[] = []
      currentLevel = -1
      nextLevel = -1
      liveSyncPosition: number | null = null
      constructor(config?: unknown) {
        counter.instances += 1
        configs.push(config)
      }
      on(): void {}
      loadSource(): void {}
      attachMedia(): void {}
      destroy(): void {}
    }
    const Hls = Object.assign(FakeInstance, {
      isSupported: () => supported,
      Events: {
        MANIFEST_PARSED: 'manifestParsed',
        LEVEL_LOADED: 'levelLoaded',
        LEVEL_SWITCHED: 'levelSwitched',
        ERROR: 'error',
      },
      ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' },
    })
    return { module: { default: Hls }, instances: counter.instances, configs }
  }

  /** A video element that claims native HLS, which is what Chromium actually reports. */
  function video(): HTMLVideoElement {
    const element = document.createElement('video')
    element.canPlayType = () => 'maybe'
    return element
  }

  const hlsDescriptor = (): MediaDescriptor => ({
    kind: 'hls',
    url: 'https://example.test/live.m3u8',
    input: 'https://example.test/live.m3u8',
    label: '解说',
    loop: false,
    viaProxy: false,
  })

  const originalLoader = hlsLoader.load
  afterEach(() => {
    hlsLoader.load = originalLoader
  })

  it('passes a config the real hls.js accepts', async () => {
    // The fake above accepts anything, so a config hls.js rejects on construction would
    // pass every other test here and only fail in the app. Feed the captured config to the
    // real constructor, whose validation runs before any media is attached.
    const fake = fakeModule(true)
    hlsLoader.load = () => Promise.resolve(fake.module as Awaited<ReturnType<typeof hlsLoader.load>>)
    await attachMedia(video(), { ...hlsDescriptor(), url: 'app://app/buffer/s/official/index.m3u8' })
    expect(fake.configs).toHaveLength(1)

    const { default: RealHls } = await import('hls.js')
    expect(() => new RealHls(fake.configs[0] as ConstructorParameters<typeof RealHls>[0]).destroy()).not.toThrow()
  })

  it('keeps a deliberate rewind and rate nudge through real hls.js live-sync controllers', async () => {
    const fake = fakeModule(true)
    hlsLoader.load = () => Promise.resolve(fake.module as Awaited<ReturnType<typeof hlsLoader.load>>)
    await attachMedia(video(), { ...hlsDescriptor(), url: 'app://app/buffer/s/official/index.m3u8' })
    const { default: RealHls } = await import('hls.js')
    const real = new RealHls(fake.configs[0] as ConstructorParameters<typeof RealHls>[0])
    // Exercise the installed hls.js controllers with the exact app constructor
    // config. A config-only assertion would miss a catch-up or rate reset path.
    const controllers = real as unknown as {
      streamController: {
        media: HTMLVideoElement | null
        _hasEnoughToStart: boolean
        synchronizeToLiveEdge(details: unknown): void
      }
      latencyController: { media: HTMLVideoElement | null; onTimeupdate(): void }
    }
    const element = video()
    Object.defineProperties(element, {
      duration: { configurable: true, value: Infinity },
      readyState: { configurable: true, value: 4 },
      buffered: { configurable: true, value: ranges([100, 300]) },
    })
    const details = {
      live: true, fragmentStart: 100, edge: 300, targetduration: 2,
      totalduration: 200, holdBack: 6, partHoldBack: 0, partTarget: 0,
      age: 0, drift: 1,
    }
    Object.defineProperty(real, 'latestLevelDetails', { configurable: true, get: () => details })
    controllers.streamController.media = element
    controllers.streamController._hasEnoughToStart = true
    controllers.latencyController.media = element
    try {
      // Sixty seconds behind the live edge remains inside retained media. Both
      // the normal speed and our bounded nudge must survive playlist updates.
      for (const rate of [1, 0.95, 1.05]) {
        element.currentTime = 240
        element.playbackRate = rate
        for (let update = 0; update < 3; update += 1) {
          controllers.streamController.synchronizeToLiveEdge(details)
          controllers.latencyController.onTimeupdate()
          expect(element.currentTime).toBe(240)
          expect(element.playbackRate).toBe(rate)
        }
      }
      expect(real.maxLatency).toBe(Infinity)
    } finally {
      controllers.streamController.media = null
      controllers.latencyController.media = null
      real.destroy()
    }
  })

  it('prefers hls.js even when the browser says it can play HLS natively', async () => {
    const fake = fakeModule(true)
    hlsLoader.load = () => Promise.resolve(fake.module as Awaited<ReturnType<typeof hlsLoader.load>>)

    const element = video()
    const attachment = await attachMedia(element, hlsDescriptor())

    // Chromium answers "maybe" and does play the playlist, so a capability probe would take
    // the native path on the primary target browser. That silently drops two shipped
    // features: the 画质 dropdown has no levels to list, and `backBufferLength` no longer
    // holds the 60 s of history that rewinding depends on.
    expect(attachment.mode).toBe('hlsjs')
    // Native attach would have pointed the element at the playlist itself; hls.js feeds it
    // through MSE instead, so a bare `src` here would mean both were attached at once.
    expect(element.getAttribute('src')).toBeNull()
  })

  it('falls back to native playback when hls.js cannot run', async () => {
    hlsLoader.load = () =>
      Promise.resolve(fakeModule(false).module as Awaited<ReturnType<typeof hlsLoader.load>>)

    const element = video()
    const errors: MediaError[] = []
    const attachment = await attachMedia(element, hlsDescriptor(), {
      onError: (error) => errors.push(error),
    })

    // iOS Safari: no MSE for hls.js to attach to, and the platform player is the only way to
    // play the stream at all. It must actually be handed the URL, and it must not report an
    // error — a working fallback that still says "不支持" reads as a broken source.
    expect(attachment.mode).toBe('native')
    expect(element.src).toContain('live.m3u8')
    expect(errors).toEqual([])
  })

  it('reports a fatal error when neither hls.js nor the browser can play HLS', async () => {
    hlsLoader.load = () =>
      Promise.resolve(fakeModule(false).module as Awaited<ReturnType<typeof hlsLoader.load>>)

    const element = document.createElement('video')
    element.canPlayType = () => ''
    const errors: MediaError[] = []
    await attachMedia(element, hlsDescriptor(), { onError: (error) => errors.push(error) })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.fatal).toBe(true)
    expect(errors[0]?.message).toContain('不支持')
  })

  it('tries native playback when the hls.js chunk fails to load', async () => {
    hlsLoader.load = () => Promise.reject(new Error('chunk load failed'))

    const element = video()
    const errors: MediaError[] = []
    const attachment = await attachMedia(element, hlsDescriptor(), {
      onError: (error) => errors.push(error),
    })

    // A failed chunk is a broken deploy or a dropped connection, not an unsupported browser,
    // so it must not be the end of the attempt while a working player is still available.
    expect(attachment.mode).toBe('native')
    expect(element.src).toContain('live.m3u8')
    expect(errors).toEqual([])
  })
})
