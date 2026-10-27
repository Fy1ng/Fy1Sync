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
  it('grants only namespaced read-only room access to Huya even when a Douyu ID matches', async () => {
    const f = fixture()
    const sender = vi.fn(() => ({ accountId: 'default', canAttempt: true }))
    const manager = new PipManager({ createWindow: () => f.window, sendContext: sender, source: () => ({
      url: 'app://app/buffer/a/commentary/b/index.m3u8', label: 'Huya', platform: 'huya', channel: '100', sourceRoom: '100', kind: 'hls', requiresProxy: false,
    }) })
    await manager.open('commentary')
    expect(manager.permitsRoom(2, 'huya:100')).toBe(true)
    expect(manager.permitsRoom(2, '100')).toBe(false)
    expect(manager.permitsRoom(3, 'huya:100')).toBe(false)
    expect(manager.state().sendContext.room).toBeNull()
    expect(manager.state().sendContext.canAttempt).toBe(false)
    for (const method of ['activateDouyuRoom', 'sendComposedDouyuMessage', 'getDouyuRoomInsights', 'reportDouyuPlayback', 'getDanmakuRate', 'getDanmakuUserDetails']) {
      expect(manager.permits(2, method, { room: '100' })).toBe(false)
    }
    manager.dispose(); f.manager.dispose()
  })
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
    expect(f.window.close).toHaveBeenCalledOnce()
    expect(f.manager.windowId()).toBeNull()
    expect(f.manager.permits(2, 'getEnhancedPip', {})).toBe(false)
    expect(() => f.manager.report(2, { ready: true, playing: true, mediaTime: 1, frameCount: 1 })).toThrow()
    f.manager.dispose()
    expect(f.window.close).toHaveBeenCalledOnce()
  })
  it('closes a hidden window when loading fails and permits an explicit reopen', async () => {
    const f = fixture()
    f.window.load.mockRejectedValueOnce(new Error('load failed'))
    expect(await f.manager.open('official')).toMatchObject({ phase: 'failed', audioOwner: 'main' })
    expect(f.window.close).toHaveBeenCalledOnce()
    expect(f.manager.windowId()).toBeNull()
    expect(await f.manager.open('official')).toMatchObject({ phase: 'opening' })
    f.manager.report(2, { ready: true, playing: true, mediaTime: 1, frameCount: 1 })
    expect(f.manager.state()).toMatchObject({ phase: 'ready', audioOwner: 'pip' })
    f.manager.dispose()
  })
})
