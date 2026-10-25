import { afterEach, describe, expect, it, vi } from 'vitest'
import { PipManager } from './pipManager'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(100_000)
  const window = { id: 2, load: vi.fn(async () => {}), show: vi.fn(), close: vi.fn(), resize: vi.fn(), onClosed: vi.fn(() => () => {}) }
  const manager = new PipManager({ createWindow: () => window, source: () => ({ url: 'app://app/buffer/a/official/b/index.m3u8',
    label: 'test', platform: 'douyu', channel: '100', sourceRoom: '100', kind: 'hls', requiresProxy: false }) })
  return { manager, window }
}
describe('restricted enhanced PiP shell', () => {
  it('waits for its renderer and shares the existing buffer before transferring audio', async () => {
    const f = fixture()
    expect((await f.manager.open('official')).phase).toBe('opening')
    expect(f.window.show).not.toHaveBeenCalled()
    f.manager.report(2, { ready: true, playing: true, mediaTime: 30, frameCount: 1 })
    expect(f.manager.state()).toMatchObject({ phase: 'ready', audioOwner: 'pip', streamId: 'official' })
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.manager.permits(2, 'getDouyuRoomInsights', { room: '101' })).toBe(false)
    expect(f.manager.permits(2, 'sendComposedDouyuMessage', { room: '100' })).toBe(true)
    expect(f.manager.permits(2, 'executeDouyuRenewal', { planId: 'any' })).toBe(false)
    expect(f.manager.permits(3, 'reportEnhancedPip', {})).toBe(false)
    expect(f.manager.close()).toMatchObject({ phase: 'closed', audioOwner: 'main' })
    f.manager.dispose()
  })
  it('bounds stall recovery and restores audio ownership when recovery fails', async () => {
    const f = fixture(); await f.manager.open('official', { lowPower: true })
    for (let index = 0; index < 4; index++) {
      f.manager.report(2, { ready: true, playing: true, mediaTime: 30, frameCount: 1 })
      await vi.advanceTimersByTimeAsync(12_000)
    }
    expect(f.manager.state()).toMatchObject({ phase: 'failed', audioOwner: 'main', recoveryAttempts: 3 })
    f.manager.dispose()
  })
  it('reports missing frontend readiness instead of showing a blank working feature', async () => {
    const f = fixture(); await f.manager.open('official')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.manager.state()).toMatchObject({ phase: 'failed', audioOwner: 'main' })
    expect(f.window.show).not.toHaveBeenCalled()
    f.manager.dispose()
  })
})
