/**
 * One extra live room as a floating window over the theater: dragged by its header, sized
 * from its corner, its own quality, volume, picture-in-picture and seek.
 *
 * The video inside is not React's. It belongs to the registry's `IndependentMedia` for this
 * id and is only moved into the window's container, so nothing done to the window — moving
 * it, resizing it, raising it above another — recreates or reloads it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { PlaybackSeekResult } from '../../media/playbackControls'
import type { PipState } from '../../../electron/pipManager'
import type { StreamSessionView } from '../../../electron/streamSessions'
import { Icon } from '../kit'
import { NATIVE_REASON } from '../PipButton'
import { PLATFORM_LABEL, roomFromInput } from '../sources'
import { movedRect, resizedRect, type Bounds, type Rect } from './layout'
import { descriptorFor, type MediaEntry, type MediaRegistry } from './mediaRegistry'


const SEEK_STEP = 5
const NOTICE_MS = 1600

export function streamTitle(view: StreamSessionView): { platform: string | null; room: string } {
  const platform = view.stream ? PLATFORM_LABEL[view.stream.platform] : null
  const room = roomFromInput(view.input) ?? view.stream?.channel ?? view.input
  return { platform, room }
}

function statusOf(view: StreamSessionView, playbackFailed: boolean): { tone: 'wait' | 'ok' | 'bad'; text: string } {
  if (view.phase === 'opening') return { tone: 'wait', text: '载入中' }
  if (view.phase === 'failed') return { tone: 'bad', text: '载入失败' }
  if (playbackFailed) return { tone: 'bad', text: '播放失败' }
  const buffer = view.buffer?.state
  if (buffer === 'reconnecting') return { tone: 'wait', text: '重新连接中' }
  if (buffer === 'stalled') return { tone: 'wait', text: '数据停滞' }
  if (buffer === 'failed') return { tone: 'bad', text: '缓冲失败' }
  return { tone: 'ok', text: '直播' }
}

function seekNotice(result: PlaybackSeekResult, delta: number | null): string | null {
  if (result.reason === 'cancelled') return null
  if (result.reason === 'timeout') return '跳转超时，请稍后重试'
  if (!result.ok) return delta === null ? '当前无法回到最新位置' : '当前无法跳转'
  if (delta === null) return '已回到最新位置'
  if (result.clamped) return delta < 0 ? '已到可回放范围起点' : '已到最新位置'
  return delta < 0 ? `后退 ${SEEK_STEP} 秒` : `前进 ${SEEK_STEP} 秒`
}

const isField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('input, select, textarea, [contenteditable="true"]') !== null

type Gesture = { mode: 'move' | 'resize'; pointerId: number; x: number; y: number; start: Rect }

export function StreamWindow({ view, rect, bounds, z, selected, pip, registry, onSelect, onRect, onView, onClosed, onPip }: {
  view: StreamSessionView
  rect: Rect
  bounds: Bounds
  z: number
  selected: boolean
  pip: PipState | null
  registry: MediaRegistry
  onSelect: (id: string) => void
  onRect: (id: string, rect: Rect) => void
  onView: (view: StreamSessionView) => void
  onClosed: (id: string) => void
  onPip: (state: PipState) => void
}): React.ReactNode {
  const { id } = view
  const mount = useRef<HTMLDivElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const latest = useRef<Rect | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [muted, setMuted] = useState(true)
  const [volume, setVolume] = useState(1)
  const [nativePip, setNativePip] = useState(false)
  const [playbackFailed, setPlaybackFailed] = useState(false)
  // A picture is up: a quality switch or restart keeps showing it rather than a blank panel.
  const [attached, setAttached] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Move the stable element into this window and follow what it does.
  useLayoutEffect(() => {
    const entry = registry.acquire(id)
    if (!entry) return
    const video = entry.media.video
    entry.media.mount(mount.current)
    const syncVolume = (): void => { setMuted(video.muted); setVolume(video.volume) }
    const onError = (): void => setPlaybackFailed(true)
    const onPlaying = (): void => setPlaybackFailed(false)
    const onEnter = (): void => setNativePip(true)
    const onLeave = (): void => setNativePip(false)
    syncVolume()
    video.addEventListener('volumechange', syncVolume)
    video.addEventListener('error', onError)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('enterpictureinpicture', onEnter)
    video.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      video.removeEventListener('volumechange', syncVolume)
      video.removeEventListener('error', onError)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('enterpictureinpicture', onEnter)
      video.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [id, registry])

  // Attach the controlled source whenever the backend hands over a new one.
  const stream = view.stream
  useEffect(() => {
    const entry = registry.acquire(id)
    if (!entry) return
    const arrived = view.phase === 'ready' && entry.lastPhase !== 'ready'
    entry.lastPhase = view.phase
    if (arrived) entry.readyCount += 1
    if (view.phase !== 'ready') return
    let live = true
    const attach = async (): Promise<void> => {
      let source = view.stream
      if (!source) {
        const result = await apiClient.feature('getStreamPlayback', { id })
        if (!live || !result.ok || !result.value) return
        source = result.value
      }
      const key = `${entry.readyCount}|${source.kind}|${source.url}|${source.quality ?? ''}`
      if (entry.loadedKey === key) return
      entry.loadedKey = key
      setPlaybackFailed(false)
      try {
        await entry.media.load(descriptorFor(view, source))
      } catch {
        if (live && entry.loadedKey === key) { entry.loadedKey = null; setPlaybackFailed(true) }
        return
      }
      if (entry.loadedKey !== key) return
      if (live) setAttached(true)
      void entry.media.video.play().catch(() => {})
    }
    void attach()
    return () => { live = false }
    // The view object changes with every buffer report; only these fields mean a new source.
  }, [id, registry, view.phase, stream?.url, stream?.kind, stream?.quality])

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  const media = (): MediaEntry | null => registry.peek(id)

  const flash = (text: string | null): void => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(text)
    noticeTimer.current = text ? setTimeout(() => setNotice(null), NOTICE_MS) : null
  }

  const run = async <T,>(operation: () => Promise<{ ok: true; value: T } | { ok: false; code: string; message: string }>,
    done: (value: T) => void): Promise<void> => {
    setProblem(null)
    setBusy(true)
    try {
      const result = await operation()
      if (result.ok) done(result.value)
      else if (result.code === 'stream-not-found') onClosed(id)
      else setProblem(result.message)
    } finally {
      setBusy(false)
    }
  }

  const changeQuality = (quality: string): void => {
    void run(() => apiClient.feature('switchStreamSessionQuality', { id, quality }), onView)
  }
  const restart = (): void => {
    const entry = media()
    if (entry) entry.loadedKey = null
    void run(() => apiClient.feature('restartStreamSession', { id }), onView)
  }
  const close = (): void => {
    void run(() => apiClient.feature('closeStreamSession', { id }), () => onClosed(id))
  }

  const toggleNative = (): void => {
    const entry = media()
    if (!entry) return
    setProblem(null)
    // Called straight from the click so the gesture still counts.
    void entry.media.controls.toggleNativePip().then((result) => {
      setNativePip(result.active)
      if (!result.ok && result.reason) setProblem(NATIVE_REASON[result.reason] ?? NATIVE_REASON.failed!)
    })
  }

  const enhancedHere = pip !== null && pip.streamId === id && (pip.phase === 'opening' || pip.phase === 'ready')
  const toggleEnhanced = (): void => {
    void run(
      () => enhancedHere ? apiClient.feature('closeEnhancedPip', undefined) : apiClient.feature('openEnhancedPip', { id }),
      (state) => {
        onPip(state)
        if (state.phase === 'failed') setProblem(state.message ?? '增强画中画打开失败')
      },
    )
  }

  const seek = (delta: number | null): void => {
    const entry = media()
    if (!entry) return
    const pending = delta === null ? entry.media.controls.returnToLive() : entry.media.controls.seekBy(delta)
    void pending.then((result) => flash(seekNotice(result, delta)))
  }

  const setMute = (next: boolean): void => {
    const video = media()?.media.video
    if (!video) return
    video.muted = next
    if (!next && video.volume === 0) video.volume = 1
  }
  const changeVolume = (value: number): void => {
    const video = media()?.media.video
    if (!video) return
    video.volume = value
    video.muted = value === 0
  }

  const begin = (mode: Gesture['mode']) => (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    if (mode === 'move' && event.target instanceof Element && event.target.closest('button, select, input')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    gesture.current = { mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: rect }
    latest.current = null
  }
  const move = (event: React.PointerEvent<HTMLElement>): void => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    const next = active.mode === 'move' ? movedRect(active.start, dx, dy, bounds) : resizedRect(active.start, dx, dy, bounds)
    latest.current = next
    setDraft(next)
  }
  const end = (event: React.PointerEvent<HTMLElement>): void => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    gesture.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    const value = latest.current
    latest.current = null
    if (value) onRect(id, value)
    setDraft(null)
  }
  const gestureHandlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end }

  const shown = draft ?? rect
  const title = streamTitle(view)
  const status = statusOf(view, playbackFailed)
  const qualities = stream?.qualities ?? []
  const canRetry = view.phase === 'failed' || playbackFailed

  return (
    <section
      className={`xs-window ${selected ? 'is-selected' : ''} ${draft ? 'is-moving' : ''}`.trim()}
      style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h, zIndex: z }}
      tabIndex={0}
      role="group"
      aria-label={`${title.platform ? `${title.platform} ` : ''}${title.room}`}
      data-stream-id={id}
      onPointerDownCapture={() => onSelect(id)}
      onFocus={() => onSelect(id)}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.altKey || event.metaKey || isField(event.target)) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          seek(event.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP)
        }
      }}
    >
      <header className="xs-head" onPointerDown={begin('move')} {...gestureHandlers}>
        <span className="xs-dot" data-tone={status.tone} aria-hidden="true" />
        {title.platform && <span className="xs-platform">{title.platform}</span>}
        <span className="xs-room">{title.room}</span>
        <span className="xs-status">{status.text}</span>
        <button type="button" className="icon-btn xs-close" onClick={close} disabled={busy} aria-label="关闭" title="关闭">
          <Icon name="close" />
        </button>
      </header>

      <div className="xs-stage">
        <div className="xs-mount" ref={mount} />
        {(view.phase === 'opening' && !attached) || view.phase === 'failed' || playbackFailed ? (
          <div className="xs-overlay">
            {view.phase === 'opening' && <span className="muted">正在载入</span>}
            {view.phase === 'failed' && <span className="form-error">{view.error ?? '载入失败，请稍后重试'}</span>}
            {view.phase === 'ready' && playbackFailed && <span className="form-error">播放失败，请稍后重试</span>}
            {canRetry && (
              <button type="button" className="btn-glass small" onClick={restart} disabled={busy}>
                <Icon name="refresh" /> 重试
              </button>
            )}
          </div>
        ) : null}
        {notice && <span className="xs-notice" role="status">{notice}</span>}
      </div>

      <footer className="xs-controls">
        <button type="button" className="icon-btn" onClick={() => setMute(!muted)}
          aria-label={muted ? '取消静音' : '静音'} title={muted ? '取消静音' : '静音'}>
          <Icon name={muted ? 'mute' : 'volume'} />
        </button>
        <input type="range" className="xs-volume" min={0} max={1} step={0.05} value={muted ? 0 : volume}
          style={{ '--fill': `${Math.round((muted ? 0 : volume) * 100)}%` } as React.CSSProperties}
          onChange={(event) => changeVolume(Number(event.target.value))} aria-label="音量" />
        {qualities.length > 1 && (
          <select className="xs-quality" value={stream?.quality ?? ''} disabled={busy || view.phase === 'opening'}
            onChange={(event) => changeQuality(event.target.value)} aria-label="画质">
            {!stream?.quality && <option value="" disabled>画质</option>}
            {qualities.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        )}
        <span className="xs-spacer" />
        <button type="button" className="btn-quiet small" onClick={() => seek(null)} disabled={view.phase !== 'ready'}
          title="回到直播">回到直播</button>
        <button type="button" className={`icon-btn ${nativePip ? 'is-on' : ''}`.trim()} onClick={toggleNative}
          aria-label={nativePip ? '关闭系统画中画' : '系统画中画'} title={nativePip ? '关闭系统画中画' : '系统画中画'}>
          <Icon name="pip" />
        </button>
        <button type="button" className={`btn-quiet small ${enhancedHere ? 'is-on' : ''}`.trim()} onClick={toggleEnhanced}
          disabled={busy || view.phase !== 'ready' || pip?.phase === 'opening'}
          aria-pressed={enhancedHere} title={enhancedHere ? '关闭增强画中画' : '增强画中画'}>
          增强
        </button>
      </footer>
      {problem && <p className="form-error xs-problem" role="alert">{problem}</p>}

      <span className="xs-resize" onPointerDown={begin('resize')} {...gestureHandlers} aria-hidden="true" />
    </section>
  )
}
