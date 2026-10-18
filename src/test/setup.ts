import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import 'fake-indexeddb/auto'

// jsdom ships no media pipeline: <video> never loads, never plays, and reports
// readyState 0 forever. The player is built around HTMLMediaElement, so give
// every element a small in-memory clock that behaves close enough for the unit
// tests that assert on seek/rewind bookkeeping.
interface FakeMediaState {
  currentTime: number
  duration: number
  paused: boolean
  seekableStart: number
  seekableEnd: number
}

const mediaState = new WeakMap<HTMLMediaElement, FakeMediaState>()

function stateOf(element: HTMLMediaElement): FakeMediaState {
  let state = mediaState.get(element)
  if (!state) {
    state = {
      currentTime: 0,
      duration: Number.NaN,
      paused: true,
      seekableStart: 0,
      seekableEnd: 0,
    }
    mediaState.set(element, state)
  }
  return state
}

function fakeTimeRanges(start: number, end: number): TimeRanges {
  const length = end > start ? 1 : 0
  return {
    length,
    start: (index: number) => {
      if (index >= length) throw new Error('INDEX_SIZE_ERR')
      return start
    },
    end: (index: number) => {
      if (index >= length) throw new Error('INDEX_SIZE_ERR')
      return end
    },
  } as TimeRanges
}

function installMediaStub(): void {
  const proto = window.HTMLMediaElement.prototype

  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime
    },
    set(this: HTMLMediaElement, value: number) {
      const state = stateOf(this)
      state.currentTime = value
      this.dispatchEvent(new Event('seeking'))
      this.dispatchEvent(new Event('seeked'))
      this.dispatchEvent(new Event('timeupdate'))
    },
  })

  Object.defineProperty(proto, 'duration', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).duration
    },
  })

  Object.defineProperty(proto, 'seekable', {
    configurable: true,
    get(this: HTMLMediaElement) {
      const state = stateOf(this)
      return fakeTimeRanges(state.seekableStart, state.seekableEnd)
    },
  })

  Object.defineProperty(proto, 'buffered', {
    configurable: true,
    get(this: HTMLMediaElement) {
      const state = stateOf(this)
      return fakeTimeRanges(state.seekableStart, state.seekableEnd)
    },
  })

  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).paused
    },
  })

  proto.play = function play(this: HTMLMediaElement) {
    stateOf(this).paused = false
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  }

  proto.pause = function pause(this: HTMLMediaElement) {
    stateOf(this).paused = true
    this.dispatchEvent(new Event('pause'))
  }

  proto.load = function load() {
    /* no-op: nothing to fetch in jsdom */
  }
}

installMediaStub()

/**
 * Test helper: give a media element a synthetic timebase and fire the readiness
 * events the player listens for.
 */
export function primeMediaElement(
  element: HTMLMediaElement,
  options: {
    currentTime?: number
    duration?: number
    seekableStart?: number
    seekableEnd?: number
  } = {},
): void {
  const state = stateOf(element)
  const duration = options.duration ?? 600
  state.duration = duration
  state.seekableStart = options.seekableStart ?? 0
  state.seekableEnd = options.seekableEnd ?? (Number.isFinite(duration) ? duration : 0)
  state.currentTime = options.currentTime ?? state.seekableStart
  Object.defineProperty(element, 'readyState', { configurable: true, value: 4 })
  element.dispatchEvent(new Event('loadedmetadata'))
  element.dispatchEvent(new Event('canplay'))
}

if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof window.ResizeObserver
}

if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof Element.prototype.requestFullscreen === 'undefined') {
  Element.prototype.requestFullscreen = () => Promise.resolve()
}
if (typeof document.exitFullscreen === 'undefined') {
  document.exitFullscreen = () => Promise.resolve()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
