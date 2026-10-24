import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MediaDescriptor } from '../core/types'
import { primeMediaElement } from '../test/setup'
import { attachMedia, hlsLoader } from './hlsController'
import { MediaEngine } from './mediaEngine'

function descriptor(url: string, kind: MediaDescriptor['kind'] = 'progressive'): MediaDescriptor {
  return { url, input: url, kind, label: '测试片源', loop: false, viaProxy: false }
}

function moduleFixture(supported = true) {
  const instances: FakeHls[] = []
  class FakeHls {
    static isSupported = () => supported
    static Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_LOADED: 'levelLoaded', LEVEL_SWITCHED: 'levelSwitched', ERROR: 'error' }
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' }
    handlers = new Map<string, (...args: any[]) => void>()
    levels: unknown[] = []
    media: HTMLVideoElement | null = null
    currentLevel = -1
    nextLevel = -1
    liveSyncPosition: number | null = null
    startLoad = vi.fn()
    recoverMediaError = vi.fn()
    destroy = vi.fn(() => { this.media?.removeAttribute('src'); this.media = null })
    constructor() { instances.push(this) }
    on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler) }
    loadSource() {}
    attachMedia(video: HTMLVideoElement) { this.media = video; video.src = 'blob:fixture-hls' }
    error(type = 'mediaError', fatal = true) { this.handlers.get('error')?.('error', { type, fatal, details: 'fixtureError' }) }
  }
  return { instances, module: { default: FakeHls } as unknown as Awaited<ReturnType<typeof hlsLoader.load>> }
}

const originalLoader = hlsLoader.load
const engines: MediaEngine[] = []
function engine() { const result = new MediaEngine(); engines.push(result); return result }
afterEach(() => {
  for (const instance of engines.splice(0)) instance.dispose()
  hlsLoader.load = originalLoader
})

describe('media attachment ownership', () => {
  it.each(['hlsjs', 'native', 'rejected'] as const)('does not let a delayed %s loader replace or clear the newer file', async mode => {
    let resolve!: (module: Awaited<ReturnType<typeof hlsLoader.load>>) => void
    let reject!: (error: Error) => void
    hlsLoader.load = () => new Promise((yes, no) => { resolve = yes; reject = no })
    const fixture = moduleFixture(mode === 'hlsjs')
    const player = engine()
    const video = player.element('official')
    video.canPlayType = () => 'maybe'
    const pending = player.load('official', { ...descriptor('/old.m3u8', 'hls'), loop: true })
    await player.load('official', descriptor('/new.mp4'))
    if (mode === 'rejected') reject(new Error('old chunk failed'))
    else resolve(fixture.module)
    await pending
    expect(video.getAttribute('src')).toBe('/new.mp4')
    expect(video.loop).toBe(false)
    expect(player.getState().official.descriptor?.url).toBe('/new.mp4')
    expect(player.getState().official.error).toBeNull()
    expect(fixture.instances).toHaveLength(0)
  })

  it.each(['unload', 'dispose'] as const)('cancels the pending loader on %s without reviving the element', async action => {
    let resolve!: (module: Awaited<ReturnType<typeof hlsLoader.load>>) => void
    hlsLoader.load = () => new Promise(yes => { resolve = yes })
    const fixture = moduleFixture()
    const player = engine()
    const video = player.element('official')
    const pending = player.load('official', descriptor('/old.m3u8', 'hls'))
    if (action === 'unload') player.unload('official')
    else player.dispose()
    // Cancellation settles even if the shared module import has not returned.
    await pending
    resolve(fixture.module)
    await Promise.resolve()
    expect(video.getAttribute('src')).toBeNull()
    expect(fixture.instances).toHaveLength(0)
    if (action === 'unload') expect(player.getState().official.status).toBe('empty')
  })

  it('makes stale native attachment destruction harmless after supersession', async () => {
    const video = document.createElement('video')
    const first = await attachMedia(video, descriptor('/first.mp4'))
    const next = await attachMedia(video, descriptor('/next.mp4'))
    first.destroy()
    expect(video.getAttribute('src')).toBe('/next.mp4')
    next.destroy()
    expect(video.getAttribute('src')).toBeNull()
  })

  it('releases HLS before a newer native attachment and ignores its late callbacks', async () => {
    const fixture = moduleFixture()
    hlsLoader.load = async () => fixture.module
    const player = engine()
    await player.load('official', descriptor('/first.m3u8', 'hls'))
    const first = fixture.instances[0]!
    await player.load('official', descriptor('/next.mp4'))
    first.error()
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(first.recoverMediaError).not.toHaveBeenCalled()
    expect(player.element('official').getAttribute('src')).toBe('/next.mp4')
    expect(player.getState().official.error).toBeNull()
  })

  it('does not let an already aborted attachment claim a working video', async () => {
    const video = document.createElement('video')
    const current = await attachMedia(video, descriptor('/current.mp4'))
    const cancelled = await attachMedia(video, descriptor('/cancelled.mp4'), {}, AbortSignal.abort())
    cancelled.destroy()
    expect(video.getAttribute('src')).toBe('/current.mp4')
    current.destroy()
  })
})

describe('native media failures', () => {
  it.each([[2, '读取'], [3, '解码'], [4, '格式']] as const)('reports native failure %s using a fixed classification', async (code, message) => {
    const player = engine()
    await player.load('official', descriptor('/broken.mp4'))
    const video = player.element('official')
    Object.defineProperty(video, 'error', { configurable: true, value: { code, message: 'private-file-path' } })
    video.dispatchEvent(new Event('error'))
    expect(player.getState().official).toMatchObject({ status: 'error', error: { fatal: true, message: expect.stringContaining(message) } })
    expect(JSON.stringify(player.getState().official.error)).not.toContain('private-file-path')
  })

  it('ignores queued errors from the previous resource and intentional cancellation', async () => {
    const player = engine()
    const video = player.element('official')
    const listeners = vi.spyOn(video, 'addEventListener')
    await player.load('official', descriptor('/first.mp4'))
    const previous = listeners.mock.calls.find(([event]) => event === 'error')![1] as EventListener
    await player.load('official', descriptor('/next.mp4'))
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } })
    previous(new Event('error'))
    Object.defineProperty(video, 'currentSrc', { configurable: true, value: new URL('/first.mp4', document.baseURI).href })
    video.dispatchEvent(new Event('error'))
    expect(player.getState().official.error).toBeNull()
    Object.defineProperty(video, 'currentSrc', { configurable: true, value: video.src })
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 1 } })
    video.dispatchEvent(new Event('error'))
    expect(player.getState().official.error).toBeNull()
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } })
    video.dispatchEvent(new Event('error'))
    expect(player.getState().official.status).toBe('error')
  })
})

describe('bounded HLS recovery', () => {
  async function setup() {
    const fixture = moduleFixture()
    hlsLoader.load = async () => fixture.module
    const player = engine()
    await player.load('official', descriptor('/live.m3u8', 'hls'))
    const video = player.element('official')
    primeMediaElement(video, { duration: 600, currentTime: 42 })
    return { player, video, hls: fixture.instances[0]! }
  }

  it.each(['mediaError', 'networkError'])('makes a recovered %s usable without replacing the video or resetting its position', async type => {
    const { player, video, hls } = await setup()
    hls.error(type)
    expect(player.getState().official.status).toBe('error')
    expect(type === 'mediaError' ? hls.recoverMediaError : hls.startLoad).toHaveBeenCalledTimes(1)
    video.dispatchEvent(new Event('playing'))
    expect(player.element('official')).toBe(video)
    expect(video.currentTime).toBe(42)
    expect(player.getState().official).toMatchObject({ status: 'ready', error: null })
    expect(player.snapshot('official')?.ready).toBe(true)
    expect(hls.destroy).not.toHaveBeenCalled()
  })

  it('stops an outage after three recovery attempts, even if each briefly emits playing', async () => {
    const { player, video, hls } = await setup()
    for (let index = 0; index < 4; index++) {
      hls.error()
      video.dispatchEvent(new Event('playing'))
    }
    hls.error()
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(3)
    expect(hls.destroy).toHaveBeenCalledTimes(1)
    expect(player.getState().official).toMatchObject({ status: 'error', error: { hint: expect.stringContaining('重新加载') } })
    expect(player.snapshot('official')?.ready).toBe(false)
  })

  it('resets the consecutive budget only after stable advancing playback', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { player, video, hls } = await setup()
    for (let index = 0; index < 3; index++) {
      hls.error()
      video.dispatchEvent(new Event('playing'))
    }
    await video.play()
    let position = 42
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => position })
    video.dispatchEvent(new Event('timeupdate'))
    now = 30_001; position += 30
    video.dispatchEvent(new Event('timeupdate'))
    hls.error()
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(4)
    expect(hls.destroy).not.toHaveBeenCalled()
    video.dispatchEvent(new Event('playing'))
    expect(player.snapshot('official')?.ready).toBe(true)
  })

  it('stops cleanly when hls.js throws during recovery', async () => {
    const { player, hls } = await setup()
    hls.recoverMediaError.mockImplementation(() => { throw new Error('failed recovery') })
    expect(() => hls.error()).not.toThrow()
    expect(hls.destroy).toHaveBeenCalledTimes(1)
    expect(player.getState().official.status).toBe('error')
  })
})
