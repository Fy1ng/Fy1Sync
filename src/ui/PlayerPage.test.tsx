/**
 * Mount tests for the player page, and the session-ownership rule they exist to pin down.
 *
 * These run under `<StrictMode>` on purpose. The page hands its two slots to a
 * `MediaEngine` the session owns, and StrictMode deliberately mounts, unmounts and
 * remounts every component once — so any teardown that destroys shared state shows up
 * here as a second mount that cannot find what it needs. It does not show up in
 * `session.test.ts`, where each test constructs its own session and nothing remounts.
 *
 * The bug this was written for: the page used to call `session.dispose()` on unmount,
 * which cleared the engine's runtime map, and the remounting ref callback then threw
 * `unknown role: official` before first paint.
 */

import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Session } from '../app/session'
import { SessionProvider } from '../app/SessionContext'
import type { SettingsStorage } from '../app/settings'
import { PlayerPage } from './PlayerPage'

function memoryStorage(seed: Record<string, string> = {}): SettingsStorage {
  const entries = new Map(Object.entries(seed))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  }
}

const sessions: Session[] = []

function makeSession(storage?: SettingsStorage): Session {
  // No real worker in jsdom, and these tests never sample; `boot`'s preset fetch is the
  // only network the page does and it is stubbed below.
  const session = new Session({ storage, createSampler: () => null })
  sessions.push(session)
  return session
}

function renderPage(session: Session): ReturnType<typeof render> {
  return render(
    <StrictMode>
      <SessionProvider session={session}>
        <PlayerPage />
      </SessionProvider>
    </StrictMode>,
  )
}

/**
 * Let the session's queued snapshot rebuild run; `notify` defers it to a microtask.
 *
 * A macrotask, not `await Promise.resolve()`: an audio change hops twice — the engine
 * notifies on one microtask, and the session's listener queues its own rebuild on the next
 * — so a single hop still reads the snapshot from before the change.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Both roles' `<video>` elements, as actually parented in the document. */
function mountedRoles(container: HTMLElement): string[] {
  return [...container.querySelectorAll('video')]
    .map((video) => video.dataset.role ?? '')
    .filter(Boolean)
    .sort()
}

/** Everything the sidebar currently says, for asserting a line is present or absent. */
function sidebarText(container: HTMLElement): string {
  return container.querySelector('.sidebar')?.textContent ?? ''
}

/** The 目标/实际 pair the sidebar shows, read the way a user reads them. */
function offsetReadout(container: HTMLElement): { requested: string; actual: string } {
  const cells = [...container.querySelectorAll('.status-grid dd')].map(
    (cell) => cell.textContent ?? '',
  )
  return { requested: cells[0] ?? '', actual: cells[1] ?? '' }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ presets: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
})

afterEach(() => {
  // Unmount before disposing, in that order: a live tree outliving its session is not a
  // state the app ever reaches, and relying on hook ordering to get it right is fragile.
  cleanup()
  while (sessions.length > 0) sessions.pop()?.dispose()
})

describe('PlayerPage mounting', () => {
  it('mounts both media elements and survives StrictMode double-invocation', async () => {
    const session = makeSession()

    const { container } = renderPage(session)

    // Rendering at all is the assertion: the ErrorBoundary swaps the page for 「渲染出错」
    // when a ref callback throws, so a visible `.player-page` means both mounts ran.
    expect(container.querySelector('.player-page')).toBeInTheDocument()
    expect(screen.queryByText('渲染出错')).not.toBeInTheDocument()
    expect(mountedRoles(container)).toEqual(['commentary', 'official'])
  })

  it('leaves the session usable after the page unmounts', async () => {
    const session = makeSession()
    const { unmount } = renderPage(session)

    unmount()

    // The engine still owns its elements — this is the call that used to throw.
    expect(() => session.engine.element('official')).not.toThrow()
    expect(session.engine.element('commentary')).toBeInstanceOf(HTMLVideoElement)
    expect(session.snapshot.autoSync.nextRunInSeconds).toBeNull()
  })

  it('remounts cleanly onto the same session, as a route switch back does', async () => {
    const session = makeSession()
    const first = renderPage(session)
    const official = session.engine.element('official')
    first.unmount()

    const { container } = renderPage(session)

    expect(container.querySelector('.player-page')).toBeInTheDocument()
    expect(mountedRoles(container)).toEqual(['commentary', 'official'])
    // The same element, moved back in: a fresh one would have lost the buffer, the hls.js
    // attachment and the playhead that sync is measured against.
    expect(session.engine.element('official')).toBe(official)
    expect(official.parentElement).not.toBeNull()
  })
})

describe('overlay bar visibility', () => {
  it('shows the controls on first paint while nothing is playing', () => {
    const { container } = renderPage(makeSession())

    // Hidden means `pointer-events: none`, so a bar that starts hidden does not just look
    // absent — clicks fall through to the video and the play button cannot be pressed.
    expect(container.querySelector('.overlay-bar')).toHaveClass('is-visible')
  })

  it('keeps the controls up while paused, past the idle timeout', () => {
    vi.useFakeTimers()
    try {
      const { container } = renderPage(makeSession())
      vi.advanceTimersByTime(30_000)
      expect(container.querySelector('.overlay-bar')).toHaveClass('is-visible')
    } finally {
      vi.useRealTimers()
    }
  })

  it('comes up windowed where the Fullscreen API is missing', () => {
    // `document.fullscreenElement` is absent here, as it is in older WebKit. Reading that
    // as "already fullscreen" cost the sidebar its slot and left the button offering only
    // 退出全屏 — a state the user cannot leave, since there is nothing to exit.
    expect('fullscreenElement' in document).toBe(false)

    const { container } = renderPage(makeSession())

    expect(container.querySelector('.sidebar')).not.toBeNull()
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument()
  })
})

describe('overlay bar volume', () => {
  it('gives each source its own volume slider', () => {
    renderPage(makeSession())

    // Two sliders is the whole point of the layout: the official feed supplies the picture
    // and the commentary the audio, so one shared control could not express the mix the
    // tool exists to produce. docs/ui-layout.md calls them mandatory.
    expect(screen.getByLabelText('官方音量')).toBeInTheDocument()
    expect(screen.getByLabelText('解说音量')).toBeInTheDocument()
  })

  it('moves one source without touching the other', async () => {
    const session = makeSession()
    renderPage(session)
    fireEvent.change(screen.getByLabelText('官方音量'), { target: { value: '0.6' } })
    await flush()

    fireEvent.change(screen.getByLabelText('解说音量'), { target: { value: '0.4' } })
    await flush()

    expect(session.snapshot.media.commentary.volume).toBeCloseTo(0.4, 2)
    // One shared gain node behind both sliders would show up right here.
    expect(session.snapshot.media.official.volume).toBeCloseTo(0.6, 2)
  })

  it('shows a muted source at zero while remembering its level', async () => {
    const session = makeSession()
    renderPage(session)
    await flush()

    // The commentary carries the audio, so it is the source that starts open.
    expect(screen.getByLabelText<HTMLInputElement>('解说音量').value).toBe('1')

    fireEvent.click(screen.getByLabelText('解说静音'))
    await flush()

    // A full-looking slider on a silent source reads as a broken player, so the control
    // drops to 0 — but the level itself is kept, not zeroed.
    expect(screen.getByLabelText<HTMLInputElement>('解说音量').value).toBe('0')
    expect(session.snapshot.media.commentary).toMatchObject({ muted: true, volume: 1 })

    fireEvent.click(screen.getByLabelText('解说取消静音'))
    await flush()

    expect(screen.getByLabelText<HTMLInputElement>('解说音量').value).toBe('1')
  })
})

describe('overlay bar quality controls', () => {
  it('keeps the two quality entries separate, with the camera one reserved', () => {
    renderPage(makeSession())

    // docs/ui-layout.md splits quality in two: 主画面画质 drives the official feed, and
    // 摄像头画质 is held for the V0.6 webcam overlay. Both entries must exist — the reserved
    // one so the controls do not shift sideways when V0.6 lands — and they must be two
    // controls, not one. The trigger's accessible name is label + current value, so the
    // anchor keeps 画质 from also matching 摄像头画质.
    expect(screen.getByRole('button', { name: /^画质/ })).toBeInTheDocument()
    const camera = screen.getByRole('button', { name: /^摄像头画质/ })

    // Disabled, so it never implies the webcam already works, and its menu stays shut.
    expect(camera).toBeDisabled()
    fireEvent.click(camera)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('disables the main quality entry while no source offers levels', () => {
    renderPage(makeSession())

    // Nothing is loaded, so there is no ladder to choose from yet. An enabled dropdown here
    // would open onto an empty menu.
    expect(screen.getByRole('button', { name: /^画质/ })).toBeDisabled()
  })
})

describe('sync sidebar', () => {
  it('shows the requested offset and the achieved one as separate numbers', async () => {
    const session = makeSession()
    const { container } = renderPage(session)

    // Nothing is loaded, so the request cannot be honoured: the pair must disagree.
    await session.applyOffset(-6)
    await flush()

    const readout = offsetReadout(container)
    expect(readout.requested).toBe('-6.00 s')
    expect(readout.actual).toBe('0.00 s')
    // Collapsing these into one number is the failure this pins: the sidebar would claim an
    // alignment the elements never reached.
    expect(container.querySelector('.status-warning')).toHaveTextContent('还差 -6.00 s 未能应用')
  })

  it('hides the shortfall warning when the request landed', async () => {
    const session = makeSession()
    const { container } = renderPage(session)

    await session.applyOffset(0)
    await flush()

    expect(offsetReadout(container)).toEqual({ requested: '0.00 s', actual: '0.00 s' })
    expect(container.querySelector('.status-warning')).toBeNull()
  })

  it('hands scheduled sync back to the user after a manual nudge', async () => {
    const session = makeSession()
    const { container } = renderPage(session)
    // After the render: mounting runs `boot`, which re-arms the scheduler from settings.
    session.setAutoSyncEnabled(true)
    await flush()
    expect(sidebarText(container)).not.toContain('手动调整过偏移')

    fireEvent.click(screen.getByRole('button', { name: '−0.5s' }))
    await flush()

    // The scheduler must not quietly overwrite a human's choice; the sidebar says so and
    // names the way back.
    expect(session.autoSync.autoApplyAuthorized).toBe(false)
    expect(sidebarText(container)).toContain('手动调整过偏移，定时同步已暂停。点“立即同步”可重新授权。')
  })

  it('collapses on request and reports it through settings', async () => {
    const session = makeSession()
    const { container } = renderPage(session)

    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    await flush()

    expect(session.snapshot.settings.sidebarVisible).toBe(false)
    expect(container.querySelector('.sidebar')).toBeNull()
  })
})

describe('cache status', () => {
  /**
   * Enough of an EventSource for the session to consider itself connected.
   *
   * jsdom has none, and without one `connectDanmaku` bails at its `typeof EventSource`
   * guard and reports 当前环境不支持 SSE instead of connecting.
   */
  function stubEventSource(): { open: () => void } {
    const handlers = new Map<string, (event: Event) => void>()
    class Stub {
      addEventListener(type: string, handler: (event: Event) => void): void {
        handlers.set(type, handler)
      }
      removeEventListener(): void {}
      close(): void {}
    }
    vi.stubGlobal('EventSource', Stub as unknown as typeof EventSource)
    return { open: () => handlers.get('open')?.(new Event('open')) }
  }

  it('reports rewind head-room for both sources', () => {
    const { container } = renderPage(makeSession())

    // docs/ui-layout.md asks for each stream's buffer and the current rewindable range,
    // per role. Rewinding is the only move the tool has, so the head-room is what says
    // whether a requested offset is reachable at all.
    const headroom = container.querySelector('.sync-headroom')?.textContent ?? ''
    expect(headroom).toContain('官方')
    expect(headroom).toContain('解说')
    expect(headroom).toContain('未加载')
  })

  it('adds the danmaku queue to the cache readout once connected', async () => {
    const source = stubEventSource()
    const session = makeSession()
    const { container } = renderPage(session)

    // Not before connecting: a 0 from a closed connection reads as "no danmaku arriving",
    // which is a different problem from an empty queue.
    expect(sidebarText(container)).not.toContain('弹幕队列')

    session.connectDanmaku('288016')
    source.open()
    await flush()

    expect(sidebarText(container)).toContain('弹幕队列')

    // Parked, not shown: messages wait for their moment in commentary media time, so a
    // non-zero queue behind a rewound stream is the offset working rather than a stall.
    session.pushDanmaku({ text: '好球', user: '观众', color: '#fff' })
    session.pushDanmaku({ text: '再来一个', user: '观众', color: '#fff' })
    // Arrival deliberately does not notify — one re-render per message would be pathological
    // at chat rates. In the app the count refreshes on the engine's own `timeupdate`
    // cadence; `flush` is the same rebuild without waiting for playback.
    session.flush()
    await flush()

    expect(container.querySelector('.sync-headroom')?.textContent).toContain('2 条待显示')

    session.disconnectDanmaku()
    await flush()

    expect(sidebarText(container)).not.toContain('弹幕队列')
  })
})

describe('suspending the page', () => {
  it('stops the scheduler without revoking auto-apply', async () => {
    const session = makeSession()
    session.setAutoSyncEnabled(true)
    await flush()
    expect(session.snapshot.autoSync.nextRunInSeconds).not.toBeNull()

    session.suspend()
    await flush()

    expect(session.snapshot.autoSync.nextRunInSeconds).toBeNull()
    // Leaving the page is not the manual nudge that pauses scheduled sync, so the sidebar
    // must not come back showing 「手动调整过偏移」.
    expect(session.autoSync.autoApplyAuthorized).toBe(true)
  })

  it('re-arms the scheduler on the next boot', async () => {
    const session = makeSession()
    session.setAutoSyncEnabled(true)
    session.suspend()

    await session.boot()
    await flush()

    expect(session.snapshot.autoSync.nextRunInSeconds).not.toBeNull()
  })

  it('arms a scheduler that was left enabled in stored settings', async () => {
    // Only `setAutoSyncEnabled` used to start the timer, so a reload restored a toggle
    // that read on while nothing was ever scheduled.
    const stored = memoryStorage()
    makeSession(stored).setAutoSyncEnabled(true)

    const restored = makeSession(stored)

    expect(restored.snapshot.settings.autoSyncEnabled).toBe(true)
    expect(restored.snapshot.autoSync.nextRunInSeconds).toBeNull()
    await restored.boot()
    await flush()
    expect(restored.snapshot.autoSync.nextRunInSeconds).not.toBeNull()
  })
})
