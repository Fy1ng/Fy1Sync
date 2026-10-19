import { afterEach, describe, expect, it } from 'vitest'

import type { MediaDescriptor } from '../core/types'
import { MediaEngine } from './mediaEngine'
import { primeMediaElement } from '../test/setup'

function descriptor(overrides: Partial<MediaDescriptor> = {}): MediaDescriptor {
  return {
    kind: 'progressive',
    url: 'https://example.test/official.mp4',
    input: 'https://example.test/official.mp4',
    label: '官方直播',
    loop: false,
    viaProxy: false,
    ...overrides,
  }
}

const engines: MediaEngine[] = []

function makeEngine(...args: ConstructorParameters<typeof MediaEngine>): MediaEngine {
  const engine = new MediaEngine(...args)
  engines.push(engine)
  return engine
}

/** Wait for the microtask-coalesced notification to land. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Replace the setup stub's synchronous seek with one the test lands by hand, so the
 * timeout and supersession paths can be exercised. Real live streams answer a seek
 * asynchronously; the stub answering inside the assignment hides both cases.
 */
function manualSeek(element: HTMLMediaElement): (time: number) => void {
  let value = element.currentTime
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next
    },
  })
  return (time: number) => {
    value = time
    element.dispatchEvent(new Event('seeked'))
  }
}

/**
 * Give one element a multi-range buffer. The setup stub derives `buffered` from the
 * seekable window, so it can only ever describe a single range — not enough to show
 * that the scan looks past index 0.
 */
function setBufferedRanges(
  element: HTMLMediaElement,
  ranges: ReadonlyArray<readonly [number, number]>,
): void {
  const at = (index: number): readonly [number, number] => {
    const range = ranges[index]
    if (!range) throw new Error('INDEX_SIZE_ERR')
    return range
  }
  Object.defineProperty(element, 'buffered', {
    configurable: true,
    get: () =>
      ({
        length: ranges.length,
        start: (index: number) => at(index)[0],
        end: (index: number) => at(index)[1],
      }) as TimeRanges,
  })
}

afterEach(() => {
  while (engines.length > 0) engines.pop()?.dispose()
})

describe('MediaEngine element ownership', () => {
  it('keeps the same element across mount moves', () => {
    const engine = makeEngine()
    const main = document.createElement('div')
    const preview = document.createElement('div')
    const element = engine.element('official')

    engine.mount('official', main)
    expect(element.parentElement).toBe(main)

    engine.mount('official', preview)
    // The identity check is the point: a remount would have replaced the node and
    // thrown away the buffer with it.
    expect(engine.element('official')).toBe(element)
    expect(element.parentElement).toBe(preview)
    expect(main.childElementCount).toBe(0)
  })

  it('is a no-op when the element is already in the container', () => {
    const engine = makeEngine()
    const main = document.createElement('div')
    const element = engine.element('official')
    engine.mount('official', main)
    engine.mount('official', main)
    expect(main.childElementCount).toBe(1)
    expect(element.parentElement).toBe(main)
  })

  it('detaches on a null container', () => {
    const engine = makeEngine()
    const main = document.createElement('div')
    engine.mount('commentary', main)
    engine.mount('commentary', null)
    expect(main.childElementCount).toBe(0)
  })

  it('sets crossOrigin so frames can be read back for recognition', () => {
    const engine = makeEngine()
    // Without this a cross-origin frame taints the canvas and getImageData throws.
    expect(engine.element('official').crossOrigin).toBe('anonymous')
  })

  it('starts both roles muted', () => {
    const engine = makeEngine()
    expect(engine.element('official').muted).toBe(true)
    expect(engine.element('commentary').muted).toBe(true)
  })
})

describe('MediaEngine load', () => {
  it('restores playback rate on source replacement, unload and disposal', async () => {
    const engine = makeEngine()
    const official = engine.element('official')
    const commentary = engine.element('commentary')
    official.playbackRate = 0.95
    await engine.load('official', descriptor())
    expect(official.playbackRate).toBe(1)
    official.playbackRate = 1.05
    engine.unload('official')
    expect(official.playbackRate).toBe(1)
    commentary.playbackRate = 0.95
    engine.dispose()
    expect(commentary.playbackRate).toBe(1)
  })

  it('reports loading, then ready once metadata arrives', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    expect(engine.getState().official.status).toBe('loading')
    expect(engine.getState().official.attachMode).toBe('native')

    primeMediaElement(engine.element('official'), { duration: 600 })
    expect(engine.getState().official.status).toBe('ready')
    expect(engine.getState().official.timebase).toEqual({ kind: 'vod', duration: 600 })
  })

  it('applies the descriptor loop flag', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor({ kind: 'test', loop: true }))
    expect(engine.element('official').loop).toBe(true)
  })

  it('notifies subscribers about a state change', async () => {
    const engine = makeEngine()
    const seen: string[] = []
    engine.subscribe((state) => seen.push(state.official.status))
    await engine.load('official', descriptor())
    await flush()
    expect(seen).toContain('loading')
  })

  it('reports a fatal error when HLS cannot be played at all', async () => {
    const engine = makeEngine()
    await engine.load('commentary', descriptor({ kind: 'hls' }))
    const state = engine.getState().commentary
    // jsdom has no Media Source Extensions, which is the real "unsupported browser"
    // case: it must surface as an error, not as a source that silently never starts.
    expect(state.status).toBe('error')
    expect(state.error?.fatal).toBe(true)
    expect(state.attachMode).toBe('native')
  })

  it('coalesces a burst of media events into one notification', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600 })
    await flush()

    let calls = 0
    engine.subscribe(() => {
      calls += 1
    })
    for (let index = 0; index < 10; index += 1) {
      element.dispatchEvent(new Event('timeupdate'))
    }
    await flush()
    expect(calls).toBe(1)
  })
})

describe('MediaEngine snapshot', () => {
  it('is null before anything is loaded', () => {
    expect(makeEngine().snapshot('official')).toBeNull()
  })

  it('reports ready only once metadata has arrived', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    // No timebase yet, so the planner has nothing to work with.
    expect(engine.snapshot('official')).toBeNull()

    primeMediaElement(engine.element('official'), { duration: 600, currentTime: 12 })
    expect(engine.snapshot('official')).toEqual({
      role: 'official',
      currentTime: 12,
      timebase: { kind: 'vod', duration: 600 },
      ready: true,
    })
  })

  it('reports a live timebase from the seekable range', async () => {
    const engine = makeEngine()
    await engine.load('commentary', descriptor({ label: '解说直播' }))
    primeMediaElement(engine.element('commentary'), {
      duration: Number.POSITIVE_INFINITY,
      seekableStart: 100,
      seekableEnd: 220,
      currentTime: 210,
    })
    expect(engine.snapshot('commentary')).toEqual({
      role: 'commentary',
      currentTime: 210,
      timebase: { kind: 'live', seekableStart: 100, seekableEnd: 220 },
      ready: true,
    })
    expect(engine.getState().commentary.isLive).toBe(true)
  })
})

describe('MediaEngine buffered range', () => {
  it('reports the end of the range holding the playhead', async () => {
    const engine = makeEngine()
    await engine.load('commentary', descriptor())
    primeMediaElement(engine.element('commentary'), {
      duration: Number.POSITIVE_INFINITY,
      seekableStart: 100,
      seekableEnd: 220,
      currentTime: 210,
    })

    // How much runway is left before the source stalls — what the rewind planner
    // checks a target against.
    expect(engine.getState().commentary.bufferedEnd).toBe(220)
  })

  it('still reports the range end when the playhead sits just before its start', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    primeMediaElement(engine.element('official'), {
      duration: Number.POSITIVE_INFINITY,
      seekableStart: 100,
      seekableEnd: 220,
      // Inside the 0.25s tolerance: right after a seek the playhead can land a few
      // milliseconds ahead of the range that was just filled for it.
      currentTime: 99.9,
    })

    expect(engine.getState().official.bufferedEnd).toBe(220)
  })

  it('falls back to the playhead itself when nothing is buffered', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    // An empty buffered list, as it is before the first bytes land.
    primeMediaElement(engine.element('official'), {
      duration: 600,
      seekableStart: 0,
      seekableEnd: 0,
      currentTime: 12,
    })

    // Reporting 0 here would read as "no runway" and make every rewind look unsafe.
    expect(engine.getState().official.bufferedEnd).toBe(12)
  })

  it('picks the covering range out of several, and ignores the ones it is not in', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 150 })
    setBufferedRanges(element, [
      [0, 30],
      [100, 220],
    ])
    element.dispatchEvent(new Event('progress'))

    // The second range answers, so the scan cannot be stopping at index 0.
    expect(engine.getState().official.bufferedEnd).toBe(220)

    // A playhead in the hole between two ranges belongs to neither.
    element.currentTime = 60
    expect(engine.getState().official.bufferedEnd).toBe(60)

    element.currentTime = 20
    expect(engine.getState().official.bufferedEnd).toBe(30)
  })
})

describe('MediaEngine seek', () => {
  it('refuses before metadata, because currentTime would be meaningless', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    await expect(engine.seek('official', 30)).resolves.toBe(false)
  })

  it('confirms a seek the element completed', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    primeMediaElement(engine.element('official'), { duration: 600, currentTime: 100 })
    await expect(engine.seek('official', 60)).resolves.toBe(true)
    expect(engine.element('official').currentTime).toBe(60)
  })

  it('resolves immediately when already at the target', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 100 })
    // A no-op assignment fires no `seeked` event, so waiting for one would hang.
    manualSeek(element)
    await expect(engine.seek('official', 100)).resolves.toBe(true)
    expect(element.currentTime).toBe(100)
  })

  it('clamps a rewind past the start of a live window', async () => {
    const engine = makeEngine()
    await engine.load('commentary', descriptor())
    primeMediaElement(engine.element('commentary'), {
      duration: Number.POSITIVE_INFINITY,
      seekableStart: 100,
      seekableEnd: 220,
      currentTime: 210,
    })
    // 30 s is outside the window; the element goes as far as it can and says so.
    await expect(engine.seek('commentary', 30)).resolves.toBe(true)
    expect(engine.element('commentary').currentTime).toBe(100)
  })

  it('fails a seek the element never answers', async () => {
    const engine = makeEngine({ seekTimeoutMs: 10 })
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 100 })
    manualSeek(element)
    // Never landed, so claiming success would let auto sync report a false alignment.
    await expect(engine.seek('official', 60)).resolves.toBe(false)
  })

  it('fails a seek that landed somewhere else', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 100 })
    const land = manualSeek(element)
    const pending = engine.seek('official', 60)
    land(75)
    await expect(pending).resolves.toBe(false)
  })

  it('fails the superseded seek and honours the newer one', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 100 })
    const land = manualSeek(element)

    const first = engine.seek('official', 60)
    const second = engine.seek('official', 30)
    land(30)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })

  it('fails a pending seek when the source is unloaded', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    const element = engine.element('official')
    primeMediaElement(element, { duration: 600, currentTime: 100 })
    manualSeek(element)
    const pending = engine.seek('official', 60)
    engine.unload('official')
    await expect(pending).resolves.toBe(false)
  })
})

describe('MediaEngine audio and unload', () => {
  it('gives audio to exactly one role', async () => {
    const engine = makeEngine()
    await engine.load('official', descriptor())
    await engine.load('commentary', descriptor())

    engine.setAudioRole('commentary')
    expect(engine.element('commentary').muted).toBe(false)
    expect(engine.element('official').muted).toBe(true)


    engine.setAudioRole('official')
    expect(engine.element('official').muted).toBe(false)
    expect(engine.element('commentary').muted).toBe(true)
  })

  it('unmutes when the volume is raised from silence', () => {
    const engine = makeEngine()
    engine.setVolume('commentary', 0.5)
    expect(engine.element('commentary').muted).toBe(false)
    expect(engine.element('commentary').volume).toBe(0.5)
  })

  it('clamps volume to the valid range', () => {
    const engine = makeEngine()
    engine.setVolume('official', 4)
    expect(engine.element('official').volume).toBe(1)
    engine.setVolume('official', -2)
    expect(engine.element('official').volume).toBe(0)
  })

  it('records the level in state before any source is loaded', async () => {
    const engine = makeEngine()
    const seen: number[] = []
    engine.subscribe((state) => seen.push(state.commentary.volume))
    engine.setVolume('commentary', 0.4)
    await flush()
    const state = engine.getState().commentary
    // The overlay renders the slider from state, not from the element. Taking the level onto
    // the element alone made the control spring back to 0 until a source happened to load.
    expect(state.status).toBe('empty')
    expect(state.volume).toBeCloseTo(0.4, 5)
    expect(state.muted).toBe(false)
    expect(seen).toContain(0.4)
  })

  it('records a mute toggle on an empty source too', () => {
    const engine = makeEngine()
    engine.setVolume('official', 0.8)
    engine.setMuted('official', true)
    expect(engine.getState().official).toMatchObject({ volume: 0.8, muted: true })
    engine.setMuted('official', false)
    expect(engine.getState().official).toMatchObject({ volume: 0.8, muted: false })
  })

  it('does not notify when an empty source is set to the level it already has', async () => {
    const engine = makeEngine()
    engine.setVolume('official', 0.5)
    await flush()
    let notifications = 0
    // `subscribe` does not replay the current state, so the count starts from real changes.
    engine.subscribe(() => {
      notifications += 1
    })
    engine.setVolume('official', 0.5)
    engine.setMuted('official', false)
    await flush()
    expect(notifications).toBe(0)
  })

  it('keeps volume and mute across an unload', async () => {
    const engine = makeEngine()
    await engine.load('commentary', descriptor())
    engine.setVolume('commentary', 0.25)
    engine.unload('commentary')
    const state = engine.getState().commentary
    // Re-picking the volume after every source change would be tedious.
    expect(state.volume).toBe(0.25)
    expect(state.muted).toBe(false)
    expect(state.status).toBe('empty')
    expect(state.descriptor).toBeNull()
    expect(engine.snapshot('commentary')).toBeNull()
  })

  it('removes the elements on dispose', () => {
    const engine = new MediaEngine()
    const host = document.createElement('div')
    engine.mount('official', host)
    engine.dispose()
    expect(host.childElementCount).toBe(0)
  })
})
