/**
 * Secondary picture preview on the main stage: shows whichever synchronized source is not on
 * the big screen.
 *
 * Clicking without dragging swaps the main and secondary roles; dragging moves the preview,
 * and dragging any of the 8 edges or corners resizes it proportionally. Until moved or
 * resized, CSS keeps it in the bottom-right corner clearing the dock; once customized, its
 * stage-relative position and width persist across reloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../app/SessionContext'
import { TWITCH_COMMERCIAL_BREAK_BADGE, TWITCH_COMMERCIAL_BREAK_NOTICE } from '../core/commercialBreak'
import type { SourceRole } from '../core/types'
import {
  clampAspectWindow,
  DRAG_THRESHOLD_PX,
  RELEASE_DANMAKU_HOVER_EVENT,
  RESIZE_HANDLES,
  resizeAspectWindow,
  type AspectWindow,
  type ResizeHandle,
} from '../ui/floatingWindow'
import { Icon } from './kit'
import type { PreviewStatusBadge } from './officialFallback'
import { ROLE_LABEL } from './sources'

export const PREVIEW_WINDOW_STORAGE_KEY = 'studio.previewWindow.v1'
export const PREVIEW_WIDTH_BOUNDS = { min: 0.12, max: 0.6 } as const

export type PreviewStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): PreviewStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function normalizePreviewWindow(raw: unknown): AspectWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { x, y, width } = raw as Partial<AspectWindow>
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) return null
  return clampAspectWindow({ x, y, width }, { width: 0, height: 0 }, 16 / 9, PREVIEW_WIDTH_BOUNDS)
}

export function loadPreviewWindow(storage: PreviewStorage | null = defaultStorage()): AspectWindow | null {
  try {
    const raw = storage?.getItem(PREVIEW_WINDOW_STORAGE_KEY)
    return raw ? normalizePreviewWindow(JSON.parse(raw) as unknown) : null
  } catch {
    return null
  }
}

export function savePreviewWindow(win: AspectWindow, storage: PreviewStorage | null = defaultStorage()): void {
  const normalized = normalizePreviewWindow(win)
  if (!normalized) return
  try {
    storage?.setItem(PREVIEW_WINDOW_STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Full or blocked storage must not interrupt playback.
  }
}

export function PreviewPip({
  role,
  mountRef,
  stageRef,
  fitStage = false,
  commercialBreak = false,
  statusBadge = null,
  onSwap,
  onHide,
}: {
  role: SourceRole
  mountRef: (node: HTMLDivElement | null) => void
  stageRef: React.RefObject<HTMLDivElement | null>
  fitStage?: boolean
  commercialBreak?: boolean
  statusBadge?: PreviewStatusBadge | null
  onSwap: () => void
  onHide: () => void
}): React.ReactNode {
  const session = useSession()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const swapRef = useRef<HTMLButtonElement | null>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [saved, setSaved] = useState<AspectWindow | null>(() => loadPreviewWindow())
  const [draft, setDraft] = useState<AspectWindow | null>(null)
  const suppressClick = useRef(false)
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const gesture = useRef<{
    mode: 'move' | ResizeHandle
    pointerId: number
    x: number
    y: number
    origin: AspectWindow
    started: boolean
    next: AspectWindow | null
    frame: number | null
  } | null>(null)

  const clearStageDragging = useCallback(() => {
    stageRef.current?.removeAttribute('data-window-dragging')
    rootRef.current?.removeAttribute('data-dragging')
  }, [stageRef])

  useEffect(() => () => {
    if (gesture.current?.frame != null) cancelAnimationFrame(gesture.current.frame)
    if (suppressTimer.current !== null) clearTimeout(suppressTimer.current)
    gesture.current = null
    clearStageDragging()
  }, [clearStageDragging])

  useEffect(() => {
    const node = stageRef.current
    if (!node) return
    const measure = (): void => setStage({ width: node.clientWidth, height: node.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [stageRef])

  const aspect = (() => {
    const video = session.engine.element(role)
    return video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
  })()

  const active = draft ?? (saved && (fitStage || stage.width > 0) ? clampAspectWindow(saved, stage, aspect, PREVIEW_WIDTH_BOUNDS) : saved)

  const measureCurrentWindow = useCallback((): AspectWindow => {
    if (active) return active
    const stageNode = stageRef.current
    const pipNode = rootRef.current
    if (stageNode && pipNode) {
      const s = stageNode.getBoundingClientRect()
      const p = pipNode.getBoundingClientRect()
      if (s.width > 0 && s.height > 0 && p.width > 0) {
        return clampAspectWindow(
          { x: (p.left - s.left) / s.width, y: (p.top - s.top) / s.height, width: p.width / s.width },
          { width: s.width, height: s.height },
          aspect,
          PREVIEW_WIDTH_BOUNDS,
        )
      }
    }
    return clampAspectWindow({ x: 0.76, y: 0.68, width: 0.22 }, stage, aspect, PREVIEW_WIDTH_BOUNDS)
  }, [active, aspect, stage, stageRef])

  const commit = useCallback((next: AspectWindow) => {
    setSaved(next)
    savePreviewWindow(next)
  }, [])

  const markDragging = useCallback((): void => {
    stageRef.current?.setAttribute('data-window-dragging', 'true')
    rootRef.current?.setAttribute('data-dragging', 'true')
    window.dispatchEvent(new Event(RELEASE_DANMAKU_HOVER_EVENT))
  }, [stageRef])

  const stepGesture = useCallback((clientX: number, clientY: number): void => {
    const state = gesture.current
    if (!state || stage.width <= 0 || stage.height <= 0) return
    const dxPx = clientX - state.x
    const dyPx = clientY - state.y

    if (!state.started) {
      if (Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return
      state.started = true
      suppressClick.current = true
      try { swapRef.current?.setPointerCapture?.(state.pointerId) } catch { /* Window listeners remain active. */ }
      markDragging()
      setDraft(state.origin)
    }

    const next = state.mode === 'move'
      ? clampAspectWindow({ x: state.origin.x + dxPx / stage.width, y: state.origin.y + dyPx / stage.height, width: state.origin.width }, stage, aspect, PREVIEW_WIDTH_BOUNDS)
      : resizeAspectWindow(state.origin, state.mode, dxPx, dyPx, stage, aspect, PREVIEW_WIDTH_BOUNDS)
    state.next = next

    if (state.mode === 'move') {
      const node = rootRef.current
      if (node) {
        node.style.transform = `translate(${(next.x - state.origin.x) * stage.width}px, ${(next.y - state.origin.y) * stage.height}px)`
      }
      return
    }
    state.frame ??= requestAnimationFrame(() => {
      state.frame = null
      if (gesture.current === state && state.next) setDraft(state.next)
    })
  }, [aspect, markDragging, stage])

  const finishGesture = useCallback((): void => {
    const state = gesture.current
    if (!state) return
    gesture.current = null
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    if (rootRef.current) rootRef.current.style.transform = ''
    clearStageDragging()
    setDraft(null)
    if (state.started && state.next) {
      commit(state.next)
      if (suppressTimer.current !== null) clearTimeout(suppressTimer.current)
      suppressTimer.current = setTimeout(() => { suppressClick.current = false; suppressTimer.current = null }, 0)
    }
  }, [clearStageDragging, commit])

  // Window-level listeners ensure fast pointer flicks past the 4px threshold never drop the drag.
  useEffect(() => {
    if (stage.width <= 0 || stage.height <= 0) return
    const onMove = (event: PointerEvent): void => {
      if (gesture.current && gesture.current.pointerId === event.pointerId) {
        stepGesture(event.clientX, event.clientY)
      }
    }
    const onEnd = (event: PointerEvent): void => {
      if (gesture.current && gesture.current.pointerId === event.pointerId) {
        finishGesture()
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [finishGesture, stage.height, stage.width, stepGesture])

  const beginMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || stage.width <= 0 || stage.height <= 0) return
    gesture.current = {
      mode: 'move',
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: measureCurrentWindow(),
      started: false,
      next: null,
      frame: null,
    }
  }

  const beginResize = (handle: ResizeHandle) => (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || stage.width <= 0 || stage.height <= 0) return
    event.preventDefault()
    event.stopPropagation()
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* Synthetic pointer in tests. */ }
    const origin = measureCurrentWindow()
    markDragging()
    setDraft(origin)
    gesture.current = {
      mode: handle,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin,
      started: true,
      next: origin,
      frame: null,
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (stage.width <= 0 || stage.height <= 0) return
    const current = measureCurrentWindow()
    if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
      const grow = event.key === '+' || event.key === '='
      const step = event.shiftKey ? 0.04 : 0.015
      event.preventDefault()
      event.stopPropagation()
      commit(clampAspectWindow({ ...current, width: current.width + (grow ? step : -step) }, stage, aspect, PREVIEW_WIDTH_BOUNDS))
      return
    }
    if (event.altKey) {
      const step = event.shiftKey ? 0.04 : 0.015
      const widthDelta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? step
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : 0
      if (!widthDelta) return
      event.preventDefault()
      event.stopPropagation()
      commit(clampAspectWindow({ ...current, width: current.width + widthDelta }, stage, aspect, PREVIEW_WIDTH_BOUNDS))
      return
    }
    const step = event.shiftKey ? 0.05 : 0.01
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    event.stopPropagation()
    commit(clampAspectWindow({ ...current, x: current.x + d[0], y: current.y + d[1] }, stage, aspect, PREVIEW_WIDTH_BOUNDS))
  }

  const placed = active && stage.width > 0 && stage.height > 0
    ? {
        left: `${active.x * stage.width}px`,
        top: `${active.y * stage.height}px`,
        width: `${active.width * stage.width}px`,
        height: `${(active.width * stage.width) / aspect}px`,
        right: 'auto',
        bottom: 'auto',
        aspectRatio: 'auto',
      } satisfies React.CSSProperties
    : undefined

  return (
    <div
      ref={rootRef}
      className="pip"
      data-role={role}
      data-placed={placed ? 'true' : undefined}
      data-status-tone={statusBadge?.tone}
      style={placed}
      onKeyDown={onKeyDown}
    >
      <button
        ref={swapRef}
        type="button"
        className="pip-swap"
        onPointerDown={beginMove}
        onLostPointerCapture={finishGesture}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false
            event.preventDefault()
            return
          }
          onSwap()
        }}
        aria-label={`将${ROLE_LABEL[role]}切换为主画面`}
        title={statusBadge ? statusBadge.text : '切换为主画面'}
      >
        <span className="pip-mount" ref={mountRef} />
        {(statusBadge || commercialBreak) && (
          <span className="pip-badges">
            {statusBadge && (
              <span className="pip-status-badge" data-tone={statusBadge.tone} role="status">
                <span className="pip-status-dot" aria-hidden="true" />
                {statusBadge.text}
              </span>
            )}
            {commercialBreak && (
              <span className="pip-ad-badge" title={TWITCH_COMMERCIAL_BREAK_NOTICE}>{TWITCH_COMMERCIAL_BREAK_BADGE}</span>
            )}
          </span>
        )}
        <span className="pip-label">{ROLE_LABEL[role]}</span>
      </button>
      <button type="button" className="pip-hide" onClick={onHide} aria-label="隐藏小画面" title="隐藏小画面">
        <Icon name="close" />
      </button>
      <div className="pip-handles" aria-hidden="true">
        {RESIZE_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`pip-handle pip-handle-${handle}${handle === 'se' ? ' pip-resize' : ''}`}
            data-handle={handle}
            onPointerDown={beginResize(handle)}
            onLostPointerCapture={finishGesture}
          />
        ))}
      </div>
    </div>
  )
}
