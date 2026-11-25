import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameHashSampler } from './frameHashSampler'
import type { HashRequest, HashResponse } from './frameHashProtocol'
import type { SourceRole } from '../core/types'

let frameCallbackOfficial: ((media: number) => void) | null = null
let frameCallbackCommentary: ((media: number) => void) | null = null

vi.mock('../recognition/frameGrabber', () => ({
  FULL_FRAME_ROI: { x: 0, y: 0, w: 1, h: 1 },
  FrameGrabber: class {
    busy = false
    grabScaledAsync = vi.fn(async () => ({ ok: false as const }))
    cancel = vi.fn()
    dispose = vi.fn()
  },
  startFrameLoop: (video: HTMLVideoElement, _fps: number, cb: (media: number) => void) => {
    if (video.dataset.role === 'official') frameCallbackOfficial = cb
    else frameCallbackCommentary = cb
    return () => {}
  },
}))

class FakeWorker {
  onmessage: ((event: MessageEvent<HashResponse>) => void) | null = null
  onerror: (() => void) | null = null
  nextResponse: Omit<Extract<HashResponse, { type: 'result' }>, 'type' | 'id'> = {
    match: { status: 'rejected', reason: 'no-candidates' },
    counts: { official: 30, commentary: 30 },
    historySpan: { official: 10, commentary: 10 },
    coarse: false,
  }
  postMessage(message: HashRequest): void {
    if (message.type === 'match') {
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: 'result', id: message.id, ...this.nextResponse } } as MessageEvent<HashResponse>)
      })
    }
  }
  terminate(): void {}
}

let workerInstance: FakeWorker | null = null

function makeVideo(role: SourceRole, currentTime: number): HTMLVideoElement {
  const video = document.createElement('video')
  video.dataset.role = role
  Object.defineProperties(video, {
    paused: { configurable: true, value: false },
    seeking: { configurable: true, value: false },
    ended: { configurable: true, value: false },
    readyState: { configurable: true, value: 4 },
    playbackRate: { configurable: true, value: 1 },
    videoWidth: { configurable: true, value: 1280 },
    videoHeight: { configurable: true, value: 720 },
    currentTime: { configurable: true, value: currentTime },
  })
  return video
}

describe('FrameHashSampler guidance messages', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    frameCallbackOfficial = null
    frameCallbackCommentary = null
    vi.stubGlobal('Worker', class {
      constructor() {
        workerInstance = new FakeWorker()
        return workerInstance
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function mount() {
    const videos = { official: makeVideo('official', 120), commentary: makeVideo('commentary', 40) }
    const statuses: string[] = []
    const sampler = new FrameHashSampler({
      video: role => videos[role],
      revision: () => '1:0:0',
      config: () => ({ regions: { official: { x: 0, y: 0, w: 1, h: 1 }, commentary: { x: 0, y: 0, w: 1, h: 1 } }, masks: [] }),
      onStatus: status => statuses.push(status),
    })
    return { sampler, statuses }
  }

  it('tells the user to keep playing when history span has not yet covered a large multi-ten-second delay', async () => {
    const { sampler, statuses } = mount()
    workerInstance!.nextResponse = {
      match: { status: 'rejected', reason: 'no-candidates' },
      counts: { official: 40, commentary: 40 },
      historySpan: { official: 15, commentary: 15 },
      coarse: false,
    }
    const pending = sampler.measure({ windowMs: 1000, appliedOffsetSeconds: 0, fresh: false, signal: { aborted: false } })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.message).toBe('暂未对上，若两路差几十秒请多播一会儿再试')
    expect(statuses).toContain('暂未对上，若两路差几十秒请多播一会儿再试')
    sampler.dispose()
  })

  it('guides the user to verify same match/perspective once >= 50s of history has accumulated without a match', async () => {
    const { sampler } = mount()
    workerInstance!.nextResponse = {
      match: { status: 'rejected', reason: 'no-candidates' },
      counts: { official: 120, commentary: 120 },
      historySpan: { official: 62, commentary: 58 },
      coarse: false,
    }
    const pending = sampler.measure({ windowMs: 1000, appliedOffsetSeconds: 0, fresh: false, signal: { aborted: false } })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await pending
    expect(result.message).toBe('未找到相同画面，请确认两路是同一局同视角比赛（差值不超过 60 秒）')
    sampler.dispose()
  })

  it('reports the measured gap and live-sync hint when two streams are more than 60s apart', async () => {
    const { sampler } = mount()
    const pairs = Array.from({ length: 24 }, (_, i) => ({ a: 100 + i * 0.2, b: 100 + i * 0.2, cost: 0.01 }))
    workerInstance!.nextResponse = {
      match: { status: 'ok', offset: 0, residual: 0.01, span: 4.6, pairs, confidence: 0.95 },
      counts: { official: 120, commentary: 120 },
      historySpan: { official: 60, commentary: 60 },
      coarse: true,
    }
    const pending = sampler.measure({ windowMs: 1000, appliedOffsetSeconds: 0, fresh: false, signal: { aborted: false } })
    await vi.advanceTimersByTimeAsync(450)
    frameCallbackOfficial?.(120)
    frameCallbackCommentary?.(45)
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending
    expect(result.message).toBe('两路相差约 75 秒（最多支持 60 秒），请确认是同一局或先同步时间')
    sampler.dispose()
  })
})
