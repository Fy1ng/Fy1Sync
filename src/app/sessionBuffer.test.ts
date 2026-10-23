import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BufferState } from '../../electron/bufferManager'
import { apiClient } from './apiClient'
import { Session } from './session'
import type { MediaDescriptor } from '../core/types'

let session: Session | undefined
afterEach(() => {
  session?.dispose()
  session = undefined
  vi.restoreAllMocks()
})

function subscribe(): (state: BufferState) => void {
  let receive!: (state: BufferState) => void
  vi.spyOn(apiClient, 'subscribeBuffer').mockImplementation(listener => {
    receive = listener
    return () => {}
  })
  session = new Session({ storage: { getItem: () => null, setItem() {} }, createSampler: () => null })
  return receive
}

describe('adaptive buffer notices', () => {
  it('translates a structured fallback into the existing notice strip and avoids repeated status spam', () => {
    const receive = subscribe()
    const state: BufferState = {
      role: 'official', state: 'reconnecting', seconds: 12,
      notice: { code: 'youtube-adaptive-fallback', fromHeight: 1440, toHeight: 1080 },
    }
    receive(state)
    receive({ ...state, state: 'buffering', seconds: 14 })
    receive({ ...state, state: 'ready', seconds: 18 })
    const snapshot = session!.flush()
    expect(snapshot.notices).toHaveLength(1)
    expect(snapshot.notices[0]).toMatchObject({ kind: 'warn', text: '1440p 取流失败, 已回退到 1080p' })
    expect(snapshot.buffers.official).toMatchObject({ state: 'ready', seconds: 18 })
  })

  it('allows a new fallback after a restart and does not invent a warning for ordinary HLS state', () => {
    const receive = subscribe()
    const state: BufferState = {
      role: 'official', state: 'ready', seconds: 12,
      notice: { code: 'youtube-adaptive-fallback', fromHeight: 2160, toHeight: 720 },
    }
    receive({ role: 'official', state: 'ready', seconds: 8 })
    expect(session!.flush().notices).toHaveLength(0)
    receive(state)
    receive({ role: 'official', state: 'starting', seconds: 0 })
    receive(state)
    expect(session!.flush().notices).toHaveLength(2)
    expect(session!.snapshot.notices[0]?.text).toBe('2160p 取流失败, 已回退到 720p')
  })

  it('updates displayed source quality to the best matching HLS option without reloading media', async () => {
    const receive = subscribe()
    const descriptor: MediaDescriptor = {
      kind: 'progressive', url: 'app://app/buffer/session/official/capability/index.m3u8',
      input: 'https://www.youtube.com/watch?v=abcdefghijk', label: 'YouTube 直播', platform: 'youtube',
      viaProxy: false, loop: false, sourceQuality: '308', sourceQualities: [
        { id: '308', label: '1440p60', adaptive: true, height: 1440, fps: 60 },
        { id: '399', label: '1080p60 自适应', adaptive: true, height: 1080, fps: 60 },
        { id: '299', label: '1080p', height: 1080, fps: 30 },
        { id: '301', label: '1080p60', height: 1080, fps: 60 },
      ],
    }
    await session!.loadSource('official', descriptor)
    const element = session!.engine.element('official')
    element.currentTime = 123
    await element.play()
    const load = vi.spyOn(session!.engine, 'load')
    receive({
      role: 'official', state: 'ready', seconds: 30,
      notice: { code: 'youtube-adaptive-fallback', fromHeight: 1440, toHeight: 1080 },
    })
    const actual = session!.flush().media.official.descriptor
    expect(actual?.sourceQuality).toBe('301')
    expect(actual?.url).toBe(descriptor.url)
    expect(session!.engine.getState().official.descriptor).toBe(descriptor)
    expect(descriptor.sourceQuality).toBe('308')
    expect(element.currentTime).toBe(123)
    expect(element.paused).toBe(false)
    expect(load).not.toHaveBeenCalled()

    const switchQuality = vi.spyOn(apiClient, 'switchQuality').mockResolvedValue({
      ok: false, code: 'test-refusal', message: '测试拒绝',
    })
    await session!.changeSourceQuality('official', '301')
    expect(switchQuality).not.toHaveBeenCalled()
    await session!.changeSourceQuality('official', '308')
    expect(switchQuality).toHaveBeenCalledWith('official', '308')
  })

  it('does not guess a fallback quality when the current rendition or target height does not match', async () => {
    const receive = subscribe()
    await session!.loadSource('official', {
      kind: 'progressive', url: 'app://app/buffer/session/official/capability/index.m3u8',
      input: 'https://www.youtube.com/watch?v=abcdefghijk', label: 'YouTube 直播',
      viaProxy: false, loop: false, sourceQuality: '308', sourceQualities: [
        { id: '308', label: '1440p60', adaptive: true, height: 1440, fps: 60 },
        { id: '301', label: '1080p60', height: 1080, fps: 60 },
      ],
    })
    for (const [fromHeight, toHeight] of [[2160, 1080], [1440, 720]]) {
      receive({ role: 'official', state: 'ready', seconds: 30,
        notice: { code: 'youtube-adaptive-fallback', fromHeight: fromHeight!, toHeight: toHeight! } })
      expect(session!.flush().media.official.descriptor?.sourceQuality).toBe('308')
    }
  })
})
