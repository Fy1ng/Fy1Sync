/**
 * Streamer camera overlay: a crop of the commentary picture drawn on the stage.
 *
 * Canvas, not a second <video>: the commentary element is the one MediaEngine owns and
 * syncs, and a second element would decode the stream twice and drift. Drawing a sub-rect
 * of the existing element preserves the original video for sync and recognition.
 * WebGPU optionally upscales that crop; the fallback retains the original 2D drawing.
 *
 * By default the visual picture sits beneath the scrolling danmaku layer while the 8 edge
 * and corner resize handles sit above it:
 * - Edges and corners always resize cleanly without being interrupted by passing danmaku.
 * - Hovering a danmaku over the camera body still pauses it and opens its action menu.
 * - Pressing and dragging anywhere on the camera body — even starting right on a danmaku
 *   text — releases the danmaku and drags the camera window smoothly.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { useAnimationFrame } from '../app/hooks'
import type { CameraConfig, CameraWindow } from '../app/camera'
import { normalizeWindow } from '../app/camera'
import {
  clampAspectWindow,
  DRAG_THRESHOLD_PX,
  RELEASE_DANMAKU_HOVER_EVENT,
  RESIZE_HANDLES,
  resizeAspectWindow,
  type ResizeHandle,
} from './floatingWindow'
import { useCameraUpscale, type CameraUpscaleState } from './useCameraUpscale'

const CAMERA_WIDTH_BOUNDS = { min: 0.08, max: 0.6 } as const

interface Props {
  config: CameraConfig
  onWindow: (window: CameraWindow) => void
  /** The stage the overlay is placed in; positions are fractions of its box. */
  stageRef: React.RefObject<HTMLDivElement | null>
  fitStage?: boolean
  onUpscaleState?: (state: CameraUpscaleState) => void
}

export function CameraOverlay({ config, onWindow, stageRef, fitStage = false, onUpscaleState }: Props): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const belowDanmaku = settings.danmaku.danmakuOverCamera
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState<CameraWindow | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const handlesRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{
    mode: 'move' | ResizeHandle
    pointerId: number
    x: number
    y: number
    origin: CameraWindow
    /** Where the window would land now; committed on release. */
    next: CameraWindow | null
    frame: number | null
  } | null>(null)

  const clearStageDragging = useCallback(() => {
    stageRef.current?.removeAttribute('data-window-dragging')
    box.current?.removeAttribute('data-dragging')
  }, [stageRef])

  useEffect(() => () => {
    if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame)
    drag.current = null
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

  const aspect = config.crop.h > 0 ? (config.crop.w / config.crop.h) : 16 / 9
  const videoAspect = (() => {
    const video = session.engine.element('commentary')
    return video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9
  })()
  // Crop fractions are of the video frame, so the on-screen aspect is crop aspect x frame aspect.
  const screenAspect = aspect * videoAspect
  const win = draft ?? (fitStage ? clampWindow(config.window, stage, screenAspect) : config.window)
  const widthPx = win.width * stage.width
  const heightPx = widthPx / screenAspect
  const upscale = useCameraUpscale(config, widthPx, heightPx)
  const { mode, tier, reason, supported } = upscale.state
  useEffect(() => {
    onUpscaleState?.({ mode, tier, reason, supported })
  }, [onUpscaleState, mode, tier, reason, supported])

  useAnimationFrame(() => {
    const target = canvas.current
    const video = session.engine.element('commentary')
    if (!target || !video || video.readyState < 2 || !video.videoWidth) return
    const { crop } = config
    const sx = crop.x * video.videoWidth
    const sy = crop.y * video.videoHeight
    const sw = Math.max(1, crop.w * video.videoWidth)
    const sh = Math.max(1, crop.h * video.videoHeight)
    // Preserve the legacy backing store and cap whenever GPU presentation is inactive.
    const width = Math.round(Math.min(sw, 960))
    const height = Math.round(width * (sh / sw))
    if (target.width !== width || target.height !== height) {
      target.width = width
      target.height = height
    }
    target.getContext('2d')?.drawImage(video, sx, sy, sw, sh, 0, 0, width, height)
  }, config.enabled && mode !== 'webgpu')

  const applyTranslate = (tx: number, ty: number): void => {
    const value = tx === 0 && ty === 0 ? '' : `translate(${tx}px, ${ty}px)`
    if (bodyRef.current) bodyRef.current.style.transform = value
    if (handlesRef.current) handlesRef.current.style.transform = value
  }

  const stepGesture = useCallback((clientX: number, clientY: number): void => {
    const state = drag.current
    if (!state || stage.width <= 0 || stage.height <= 0) return
    const dxPx = clientX - state.x
    const dyPx = clientY - state.y
    const next = state.mode === 'move'
      ? clampWindow({ ...state.origin, x: state.origin.x + dxPx / stage.width, y: state.origin.y + dyPx / stage.height }, stage, screenAspect)
      : clampWindow(resizeAspectWindow(state.origin, state.mode, dxPx, dyPx, stage, screenAspect, CAMERA_WIDTH_BOUNDS), stage, screenAspect)
    state.next = next
    if (state.mode === 'move') {
      applyTranslate((next.x - state.origin.x) * stage.width, (next.y - state.origin.y) * stage.height)
      return
    }
    state.frame ??= requestAnimationFrame(() => {
      state.frame = null
      if (drag.current === state && state.next) setDraft(state.next)
    })
  }, [stage, screenAspect])

  const end = useCallback((): void => {
    const state = drag.current
    if (!state) return
    drag.current = null
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    // Left and top take over from the transform before the next paint, so nothing jumps.
    applyTranslate(0, 0)
    clearStageDragging()
    setDraft(null)
    if (state.next) onWindow(state.next)
  }, [clearStageDragging, onWindow])

  const markDragging = useCallback((): void => {
    stageRef.current?.setAttribute('data-window-dragging', 'true')
    box.current?.setAttribute('data-dragging', 'true')
    window.dispatchEvent(new Event(RELEASE_DANMAKU_HOVER_EVENT))
  }, [stageRef])

  const begin = (gestureMode: 'move' | ResizeHandle) => (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* Synthetic pointer in tests. */ }
    markDragging()
    drag.current = { mode: gestureMode, pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: win, next: null, frame: null }
  }

  const move = (event: React.PointerEvent<HTMLElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    stepGesture(event.clientX, event.clientY)
  }

  // Keep hover affordance steady and hand off press-and-drag when a scrolling danmaku sits over the camera body.
  const latestWin = useRef(win)
  latestWin.current = win
  useEffect(() => {
    const stageNode = stageRef.current
    if (!stageNode || !config.enabled || stage.width <= 0) return

    let pending: { pointerId: number; x: number; y: number; origin: CameraWindow } | null = null

    const insideCamera = (clientX: number, clientY: number): boolean => {
      const rect = box.current?.getBoundingClientRect()
      return !!rect && rect.width > 0 && rect.height > 0
        && clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom
    }

    const syncPointerInside = (event: PointerEvent): void => {
      const overlayNode = box.current
      if (!overlayNode) return
      const target = event.target
      const overHigherWindow = target instanceof Element && target.closest('.pip, .extra-streams, .dm-menu') !== null
      if (!overHigherWindow && insideCamera(event.clientX, event.clientY)) {
        overlayNode.setAttribute('data-pointer-inside', 'true')
      } else {
        overlayNode.removeAttribute('data-pointer-inside')
      }
    }

    const clearPointerInside = (): void => {
      box.current?.removeAttribute('data-pointer-inside')
    }

    const onWindowMove = (event: PointerEvent): void => {
      if (pending && event.pointerId === pending.pointerId) {
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < DRAG_THRESHOLD_PX) return
        const started = pending
        pending = null
        markDragging()
        try { bodyRef.current?.setPointerCapture?.(event.pointerId) } catch { /* Fallback window listeners stay active. */ }
        drag.current = { mode: 'move', pointerId: event.pointerId, x: started.x, y: started.y, origin: started.origin, next: null, frame: null }
        stepGesture(event.clientX, event.clientY)
        return
      }
      if (drag.current && drag.current.pointerId === event.pointerId) {
        stepGesture(event.clientX, event.clientY)
      }
    }

    const onWindowEnd = (event: PointerEvent): void => {
      if (pending && event.pointerId === pending.pointerId) {
        pending = null
      }
      if (drag.current && drag.current.pointerId === event.pointerId) {
        end()
      }
    }

    const onStagePointerDown = (event: PointerEvent): void => {
      if (!belowDanmaku || event.button !== 0 || drag.current) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.danmaku-item') || target.closest('.dm-menu')) return
      if (!insideCamera(event.clientX, event.clientY)) return
      pending = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: latestWin.current }
    }

    stageNode.addEventListener('pointermove', syncPointerInside)
    stageNode.addEventListener('pointerleave', clearPointerInside)
    stageNode.addEventListener('pointerdown', onStagePointerDown)
    window.addEventListener('pointermove', onWindowMove)
    window.addEventListener('pointerup', onWindowEnd)
    window.addEventListener('pointercancel', onWindowEnd)
    return () => {
      pending = null
      clearPointerInside()
      stageNode.removeEventListener('pointermove', syncPointerInside)
      stageNode.removeEventListener('pointerleave', clearPointerInside)
      stageNode.removeEventListener('pointerdown', onStagePointerDown)
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('pointerup', onWindowEnd)
      window.removeEventListener('pointercancel', onWindowEnd)
    }
  }, [belowDanmaku, config.enabled, end, markDragging, stage.width, stageRef, stepGesture])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
      const grow = event.key === '+' || event.key === '='
      const step = event.shiftKey ? 0.04 : 0.015
      event.preventDefault()
      event.stopPropagation()
      onWindow(clampWindow({ ...win, width: win.width + (grow ? step : -step) }, stage, screenAspect))
      return
    }
    if (event.altKey) {
      const step = event.shiftKey ? 0.04 : 0.015
      const widthDelta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? step
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -step : 0
      if (!widthDelta) return
      event.preventDefault()
      event.stopPropagation()
      onWindow(clampWindow({ ...win, width: win.width + widthDelta }, stage, screenAspect))
      return
    }
    const step = event.shiftKey ? 0.05 : 0.01
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    event.stopPropagation()
    onWindow(clampWindow({ ...win, x: win.x + d[0], y: win.y + d[1] }, stage, screenAspect))
  }

  if (!config.enabled || stage.width <= 0) return null
  const innerRadius = Math.max(0, win.radius - win.border)
  return (
    <div
      ref={box}
      className="camera-overlay"
      data-below-danmaku={belowDanmaku || undefined}
      data-upscale-mode={mode}
      data-upscale-tier={tier}
      data-upscale-reason={reason}
      role="group"
      aria-label="主播摄像头小窗，拖动移动，四边或四角缩放，方向键微调"
      tabIndex={0}
      style={{
        left: `${win.x * stage.width}px`,
        top: `${win.y * stage.height}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={bodyRef}
        className="camera-body"
        style={{
          borderRadius: `${win.radius}px`,
          borderWidth: `${win.border}px`,
        }}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <canvas ref={canvas} className="camera-canvas" style={{ visibility: mode === 'webgpu' ? 'hidden' : undefined, borderRadius: `${innerRadius}px` }} />
        {upscale.active && <canvas key={upscale.canvasKey} ref={upscale.canvas} className="camera-canvas camera-canvas-gpu"
          style={{ visibility: mode === 'webgpu' ? undefined : 'hidden', borderRadius: `${innerRadius}px` }} />}
      </div>
      <div ref={handlesRef} className="camera-handles" aria-hidden="true">
        {RESIZE_HANDLES.map((handle) => (
          <span
            key={handle}
            className={`camera-handle camera-handle-${handle}${handle === 'se' ? ' camera-resize' : ''}`}
            data-handle={handle}
            onPointerDown={begin(handle)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          />
        ))}
      </div>
    </div>
  )
}

/** Keep the whole window on the stage. */
export function clampWindow(win: CameraWindow, stage: { width: number; height: number }, screenAspect: number): CameraWindow {
  const next = normalizeWindow(win)
  return clampAspectWindow(next, stage, screenAspect, CAMERA_WIDTH_BOUNDS)
}
