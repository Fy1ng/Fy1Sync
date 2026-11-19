import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DanmakuEvent, StreamSyncerBridge } from '../../../electron/contracts'
import { DEFAULT_DANMAKU_PREFERENCES } from '../../core/danmakuProcessing'
import { PipDanmaku } from './PipDanmaku'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let listeners: Map<string, (event: DanmakuEvent) => void>
let release: ReturnType<typeof vi.fn<(room: string) => void>>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  frames = new Map()
  nextFrame = 0
  listeners = new Map()
  release = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(),
    subscribeDanmaku: (room: string, listener: (event: DanmakuEvent) => void) => {
      listeners.set(room, listener)
      return () => { release(room); listeners.delete(room) }
    },
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

function present(): void {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(performance.now())
  })
}

function message(room = 'bilibili:100', id = '99') {
  return { platform: 'bilibili', room, id, text: '测试醒目留言', username: '测试观众', color: 0,
    level: 0, system: false, receivedAt: Date.now(),
    superChat: { id, price: 30, duration: 90, background: '#1565c0', color: '#ffffff' } }
}

function emit(event: string, data: unknown): void {
  act(() => listeners.get('bilibili:100')!({ event, data }))
}

describe('PiP platform overlay', () => {
  it.each(['low-power', 'reload'] as const)('drops displayed and queued Super Chats on %s', mode => {
    const props = { video: document.createElement('video'), room: 'bilibili:100',
      preferences: DEFAULT_DANMAKU_PREFERENCES, drawing: true, resetKey: 0, onProblem: vi.fn() }
    const view = render(<PipDanmaku {...props} />)
    emit('danmaku', message())
    present()
    expect(screen.getByText('测试醒目留言')).toBeInTheDocument()
    emit('danmaku', message('bilibili:100', '100'))
    view.rerender(<PipDanmaku {...props} drawing={mode !== 'low-power'} resetKey={mode === 'reload' ? 1 : 0} />)
    expect(screen.queryByText('测试醒目留言')).toBeNull()
    view.rerender(<PipDanmaku {...props} resetKey={mode === 'reload' ? 1 : 0} />)
    present()
    expect(screen.queryByText('测试醒目留言')).toBeNull()
    expect(release).not.toHaveBeenCalled()
  })

  it('scopes Super Chat messages and deletion signals to the supplied room and message ID', () => {
    const props = { video: document.createElement('video'), room: 'bilibili:100',
      preferences: DEFAULT_DANMAKU_PREFERENCES, drawing: true, resetKey: 0, onProblem: vi.fn() }
    render(<PipDanmaku {...props} />)
    emit('danmaku', message('bilibili:200'))
    present()
    expect(screen.queryByText('测试醒目留言')).toBeNull()
    emit('danmaku', message())
    present()
    expect(screen.getByText('测试醒目留言')).toBeInTheDocument()
    emit('room-signal', { platform: 'bilibili', room: 'bilibili:200', kind: 'super-chat-delete', ids: ['99'] })
    expect(screen.getByText('测试醒目留言')).toBeInTheDocument()
    emit('room-signal', { platform: 'bilibili', room: 'bilibili:100', kind: 'super-chat-delete', ids: ['100'] })
    expect(screen.getByText('测试醒目留言')).toBeInTheDocument()
    emit('room-signal', { platform: 'bilibili', room: 'bilibili:100', kind: 'super-chat-delete', ids: ['99'] })
    expect(screen.queryByText('测试醒目留言')).toBeNull()
    emit('danmaku', message())
    present()
    expect(screen.queryByText('测试醒目留言')).toBeNull()
  })

  it('clears the overlay and releases the subscription when main supplies another room', () => {
    const props = { video: document.createElement('video'), room: 'bilibili:100',
      preferences: DEFAULT_DANMAKU_PREFERENCES, drawing: true, resetKey: 0, onProblem: vi.fn() }
    const view = render(<PipDanmaku {...props} />)
    emit('danmaku', message())
    present()
    expect(screen.getByText('测试醒目留言')).toBeInTheDocument()
    view.rerender(<PipDanmaku {...props} room="huya:100" />)
    expect(screen.queryByText('测试醒目留言')).toBeNull()
    expect(release).toHaveBeenCalledExactlyOnceWith('bilibili:100')
    expect([...listeners.keys()]).toEqual(['huya:100'])
    view.unmount()
    expect(release).toHaveBeenLastCalledWith('huya:100')
    expect(frames.size).toBe(0)
  })
})
