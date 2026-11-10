import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import type { RecognitionSampler } from '../recognition/sampler'
import type { BasicClockProgress } from '../recognition/protocol'
import { primeMediaElement } from '../test/setup'
import * as search from '../core/basicClockSearch'

const sessions: Session[] = []
const source = { kind: 'progressive' as const, url: 'https://cdn.example.test/one.mp4',
  input: 'https://www.youtube.com/watch?v=official123', platform: 'youtube' as const,
  label: '测试录像', viaProxy: false, loop: false }
const roi = { x: .48, y: .04, w: .04, h: .06 }
const progress: BasicClockProgress = { diagnostic: { mode: 'auto', status: 'locked', roi, text: '1:20',
  inputSize: { width: 1920, height: 1080 } }, debug: null, frameIndex: 20, receivedAt: 1000 }

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(search, 'getBasicClockSearchRoi').mockReturnValue({ x: .45, y: 0, w: .1, h: .2 }) })
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.useRealTimers(); vi.restoreAllMocks() })

async function harness() {
  const sampler = { sample: vi.fn(), setBackgroundRoles: vi.fn(), invalidate: vi.fn(), dispose: vi.fn() }
  const session = new Session({ storage: { getItem: () => null, setItem: vi.fn() },
    createSampler: () => sampler as unknown as RecognitionSampler })
  sessions.push(session)
  await session.loadSource('official', source)
  const video = session.engine.element('official')
  Object.defineProperties(video, { videoWidth: { configurable: true, value: 1920 }, videoHeight: { configurable: true, value: 1080 } })
  primeMediaElement(video, { currentTime: 100 })
  return { session, sampler, video }
}

describe('basic background pre-recognition', () => {
  it('starts one ready playing source immediately and remembers its clock before manual sync', async () => {
    const { session, sampler, video } = await harness()
    expect(sampler.setBackgroundRoles).not.toHaveBeenCalledWith(['official'], false)
    await video.play()
    await vi.advanceTimersByTimeAsync(0)
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith(['official'], false)
    expect(sampler.sample).not.toHaveBeenCalled()
    expect(session.flush().autoSync.phase).toBe('idle')
    session.receiveBasicProgress('official', progress)
    expect(session.settings.basicClockMemory).toHaveLength(1)
    expect(session.profileFor('official')).toMatchObject({ roi, roiOrigin: 'memory' })
    expect(session.flush().media.commentary.status).toBe('empty')
  })

  it('pauses background work without disposing caches for pause, low-power PiP and suspension', async () => {
    const { session, sampler, video } = await harness()
    await video.play()
    await vi.advanceTimersByTimeAsync(0)
    session.receiveBasicProgress('official', progress)
    video.pause()
    await vi.advanceTimersByTimeAsync(0)
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith([], false)
    await video.play()
    await vi.advanceTimersByTimeAsync(0)
    session.setPresentationReduced(true)
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith([], false)
    session.setPresentationReduced(false)
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith(['official'], false)
    session.suspend()
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith([])
    expect(sampler.dispose).not.toHaveBeenCalled()
    expect(session.profileFor('official')).toMatchObject({ roiOrigin: 'memory', roi })
  })

  it('invalidates only the replaced source and excludes unfinished source changes from pre-recognition', async () => {
    const { session, sampler, video } = await harness()
    await video.play()
    await vi.advanceTimersByTimeAsync(0)
    sampler.invalidate.mockClear()
    const revision = session.beginSourceChange('official')
    await vi.advanceTimersByTimeAsync(500)
    expect(sampler.invalidate).toHaveBeenCalledExactlyOnceWith('official')
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith([], false)
    session.endSourceChange('official', revision)
    expect(sampler.setBackgroundRoles).toHaveBeenLastCalledWith(['official'], false)
    expect(sampler.sample).not.toHaveBeenCalled()
  })
})
