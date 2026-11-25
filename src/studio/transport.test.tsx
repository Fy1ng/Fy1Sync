import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { Session, type SessionSnapshot } from '../app/session'
import { Timeline } from './transport'

let session: Session
let snapshot: SessionSnapshot
vi.mock('../app/SessionContext', () => ({ useSession: () => session, useSessionSnapshot: () => snapshot }))

beforeEach(() => {
  session = new Session({ createSampler: () => null })
  const initial = session.flush()
  snapshot = { ...initial, media: { ...initial.media,
    official: { ...initial.media.official, currentTime: 100, bufferedEnd: 600, timebase: { kind: 'vod', duration: 600 } } } }
  vi.spyOn(session, 'seekPlaybackTo').mockResolvedValue(true)
})
afterEach(() => { cleanup(); session.dispose() })

describe('timeline keyboard commits', () => {
  it('keeps automatic alignment authorized when Tab moves focus onto the slider', async () => {
    render(<><button type="button">前一项</button><Timeline /></>)
    const user = userEvent.setup()
    screen.getByRole('button', { name: '前一项' }).focus()
    await user.tab()
    expect(screen.getByRole('slider', { name: '播放进度' })).toHaveFocus()
    expect(session.seekPlaybackTo).not.toHaveBeenCalled()
    expect(session.autoSync.autoApplyAuthorized).toBe(true)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])('commits a changed value on %s release', key => {
    render(<Timeline />)
    const slider = screen.getByRole('slider', { name: '播放进度' })
    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.keyUp(slider, { key })
    expect(session.seekPlaybackTo).toHaveBeenCalledExactlyOnceWith('official', 40)
  })

  it.each(['Tab', 'Shift', 'Escape', 'a', 'Enter'])('does not commit a pending drag on unrelated %s release', key => {
    render(<Timeline />)
    const slider = screen.getByRole('slider', { name: '播放进度' })
    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.keyUp(slider, { key })
    expect(session.seekPlaybackTo).not.toHaveBeenCalled()
  })

  it('does not seek for an adjustment key without an actual value change', () => {
    render(<Timeline />)
    const slider = screen.getByRole('slider', { name: '播放进度' })
    fireEvent.keyUp(slider, { key: 'ArrowRight' })
    fireEvent.change(slider, { target: { value: '100' } })
    fireEvent.keyUp(slider, { key: 'Home' })
    expect(session.seekPlaybackTo).not.toHaveBeenCalled()
  })

  it('still commits pointer dragging through the session', () => {
    render(<Timeline />)
    const slider = screen.getByRole('slider', { name: '播放进度' })
    fireEvent.change(slider, { target: { value: '40' } })
    fireEvent.pointerUp(slider)
    expect(session.seekPlaybackTo).toHaveBeenCalledExactlyOnceWith('official', 40)
  })

  it('does not falsely report lag when official is held back for alignment while commentary is at live edge', () => {
    snapshot = {
      ...snapshot,
      offsetSeconds: 12,
      requestedOffsetSeconds: 12,
      media: {
        official: {
          ...snapshot.media.official,
          status: 'ready',
          isLive: true,
          currentTime: 187.5,
          bufferedEnd: 200,
          timebase: { kind: 'live', seekableStart: 20, seekableEnd: 200 },
        },
        commentary: {
          ...snapshot.media.commentary,
          status: 'ready',
          isLive: true,
          currentTime: 99.3,
          bufferedEnd: 100,
          timebase: { kind: 'live', seekableStart: 0, seekableEnd: 100 },
        },
      },
    }
    render(<Timeline />)
    expect(screen.getByRole('button', { name: '直播' })).toBeInTheDocument()
    expect(screen.queryByText(/落后/)).toBeNull()
  })

  it('offers 同步时间 when genuinely behind buffered tail and shows 同步中 1.25× while catching up', () => {
    const syncLive = vi.spyOn(session, 'syncPlaybackToLive').mockResolvedValue(true)
    snapshot = {
      ...snapshot,
      media: {
        ...snapshot.media,
        official: {
          ...snapshot.media.official,
          status: 'ready',
          isLive: true,
          currentTime: 193,
          bufferedEnd: 200,
          timebase: { kind: 'live', seekableStart: 20, seekableEnd: 200 },
        },
      },
    }
    const { rerender } = render(<Timeline />)
    const syncBtn = screen.getByRole('button', { name: /同步时间/ })
    expect(syncBtn).toHaveTextContent('落后 7 秒 · 同步时间')
    fireEvent.click(syncBtn)
    expect(syncLive).toHaveBeenCalledWith('official')

    snapshot = { ...snapshot, liveCatchingUp: true }
    rerender(<Timeline />)
    expect(screen.getByRole('button', { name: '同步中 1.25×' })).toBeInTheDocument()
  })
})
