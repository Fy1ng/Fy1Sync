/**
 * Streamer camera overlay: a crop of the commentary picture drawn on the stage.
 *
 * Canvas, not a second <video>: the commentary element is the one MediaEngine owns and
 * syncs, and a second element would decode the stream twice and drift. Drawing a sub-rect
 * of the existing element preserves the original video for sync and recognition.
 * WebGPU optionally upscales that crop; the fallback retains the original 2D drawing.
 *
 * Dragging the body moves the window; the corner handle resizes it (height follows the
 * crop's aspect). Arrow keys move it, Shift+arrows by more. Position and size are stored as
 * fractions of the stage so fullscreen and window resizes keep it in the same place.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../app/SessionContext'
import { useAnimationFrame } from '../app/hooks'
import type { CameraConfig, CameraWindow } from '../app/camera'
import { normalizeWindow } from '../app/camera'
import { useCameraUpscale, type CameraUpscaleState } from './useCameraUpscale'

interface Props {
  config: CameraConfig
  onWindow: (window: CameraWindow) => void
  /** The stage the overlay is placed in; positions are fractions of its box. */
  stageRef: React.RefObject<HTMLDivElement | null>
  onUpscaleState?: (state: CameraUpscaleState) => void
}

export function CameraOverlay({ config, onWindow, stageRef, onUpscaleState }: Props): React.ReactNode {
  const session = useSession()
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState<CameraWindow | null>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; origin: CameraWindow } | null>(null)
  const win = draft ?? config.window

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

  const begin = (mode: 'move' | 'resize') => (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { mode, x: event.clientX, y: event.clientY, origin: win }
  }
  const move = (event: React.PointerEvent<HTMLElement>): void => {
    const state = drag.current
    if (!state || stage.width <= 0) return
    const dx = (event.clientX - state.x) / stage.width
    const dy = (event.clientY - state.y) / stage.height
    setDraft(clampWindow(state.mode === 'move'
      ? { ...state.origin, x: state.origin.x + dx, y: state.origin.y + dy }
      : { ...state.origin, width: state.origin.width + dx }, stage, screenAspect))
  }
  const end = useCallback((): void => {
    if (!drag.current) return
    drag.current = null
    setDraft((current) => {
      if (current) onWindow(current)
      return null
    })
  }, [onWindow])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.05 : 0.01
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[event.key]
    if (!d) return
    event.preventDefault()
    event.stopPropagation()
    onWindow(clampWindow({ ...win, x: win.x + d[0], y: win.y + d[1] }, stage, screenAspect))
  }

  if (!config.enabled || stage.width <= 0) return null
  return (
    <div
      className="camera-overlay"
      data-upscale-mode={mode}
      data-upscale-tier={tier}
      data-upscale-reason={reason}
      role="group"
      aria-label="主播摄像头小窗，拖动移动，右下角缩放，方向键微调"
      tabIndex={0}
      style={{
        left: `${win.x * stage.width}px`,
        top: `${win.y * stage.height}px`,
        width: `${widthPx}px`,
        height: `${heightPx}px`,
        borderRadius: `${win.radius}px`,
        borderWidth: `${win.border}px`,
      }}
      onPointerDown={begin('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
    >
      <canvas ref={canvas} className="camera-canvas" style={{ visibility: mode === 'webgpu' ? 'hidden' : undefined, borderRadius: `${Math.max(0, win.radius - win.border)}px` }} />
      {upscale.active && <canvas key={upscale.canvasKey} ref={upscale.canvas} className="camera-canvas camera-canvas-gpu"
        style={{ visibility: mode === 'webgpu' ? undefined : 'hidden', borderRadius: `${Math.max(0, win.radius - win.border)}px` }} />}
      <span
        className="camera-resize"
        aria-hidden="true"
        onPointerDown={begin('resize')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}

/** Keep the whole window on the stage. */
export function clampWindow(win: CameraWindow, stage: { width: number; height: number }, screenAspect: number): CameraWindow {
  const next = normalizeWindow(win)
  if (stage.width <= 0 || stage.height <= 0) return next
  const heightFraction = (next.width * stage.width / screenAspect) / stage.height
  // A very tall crop can be taller than the stage at the minimum width; shrink to fit.
  const width = heightFraction > 0.95 ? next.width * (0.95 / heightFraction) : next.width
  const h = Math.min(0.95, heightFraction)
  return {
    ...next,
    width,
    x: Math.min(Math.max(0, next.x), Math.max(0, 1 - width)),
    y: Math.min(Math.max(0, next.y), Math.max(0, 1 - h)),
  }
}
