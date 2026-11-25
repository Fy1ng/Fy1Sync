/**
 * Draggable/resizable ROI window drawn over the sample video.
 *
 * Coordinates are the interesting part. The ROI is stored as fractions of the *picture*,
 * not of the element, because the same profile has to work at any window size and the
 * recognition worker only ever sees frame pixels. The editor supplies its zoomed picture
 * box; other callers use `contentRect` to account for object-fit letterboxing.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { contentRect, normalizeRoi, type Rect } from '../../core/imageOps'
import type { RoiRect } from '../../core/profileSchema'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Keyboard nudges: 1 px of picture, or 10 px with Shift held. */
const NUDGE_PX = 1
const NUDGE_PX_FAST = 10

interface DragState {
  mode: Handle | 'move'
  startX: number
  startY: number
  origin: RoiRect
  content: Rect
}

export function RoiWindow({
  roi,
  onChange,
  onCommit,
  videoWidth,
  videoHeight,
  /** Element the ROI is drawn over; used to measure the painted picture box. */
  hostRef,
  contentBox,
  readOnly = false,
  label,
  ariaLabel,
  variant = 'crop',
  unit = 'px',
  bodyDraggable = true,
  selected = false,
  onSelect,
  onDelete,
}: {
  roi: RoiRect
  onChange: (roi: RoiRect) => void
  onCommit?: (roi: RoiRect) => void
  videoWidth: number
  videoHeight: number
  hostRef?: React.RefObject<HTMLDivElement | null>
  contentBox?: Rect
  readOnly?: boolean
  label?: string
  ariaLabel?: string
  variant?: 'crop' | 'mask'
  unit?: 'px' | 'percent'
  bodyDraggable?: boolean
  selected?: boolean
  onSelect?: () => void
  onDelete?: () => void
}): React.ReactNode {
  const [measured, setBox] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 })
  const box = contentBox ?? measured
  const minimum = { w: videoWidth > 0 ? 1 / videoWidth : 0.01, h: videoHeight > 0 ? 1 / videoHeight : 0.01 }
  const dragRef = useRef<DragState | null>(null)
  const latestRef = useRef<RoiRect>(roi)
  const dirtyRef = useRef(false)
  latestRef.current = roi

  // The picture box changes on resize, on fullscreen, and when metadata finally tells us
  // the intrinsic size. A ResizeObserver covers the first two; `videoWidth` in the dep
  // list covers the third.
  useEffect(() => {
    const host = hostRef?.current
    if (!host) return
    const measure = (): void => {
      setBox(contentRect(videoWidth, videoHeight, host.clientWidth, host.clientHeight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [hostRef, videoWidth, videoHeight])

  const beginDrag = (mode: Handle | 'move') => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || readOnly || box.width <= 0 || box.height <= 0) return
    event.preventDefault()
    event.stopPropagation()
    onSelect?.()
    event.currentTarget.closest<HTMLElement>('.roi-window')?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dirtyRef.current = false
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: roi,
      content: box,
    }
  }

  const continueDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = (event.clientX - drag.startX) / drag.content.width
    const dy = (event.clientY - drag.startY) / drag.content.height
    const next = applyDrag(drag.origin, drag.mode, dx, dy, minimum)
    latestRef.current = next
    dirtyRef.current = true
    onChange(next)
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (dirtyRef.current) {
      dirtyRef.current = false
      onCommit?.(latestRef.current)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && onDelete) {
      event.preventDefault()
      event.stopPropagation()
      onDelete()
      return
    }
    if (box.width <= 0) return
    const step = event.shiftKey ? NUDGE_PX_FAST : NUDGE_PX
    if (videoWidth <= 0 || videoHeight <= 0) return
    const dx = step / videoWidth
    const dy = step / videoHeight
    const resize = event.altKey
    let next: RoiRect | null = null
    if (event.key === 'ArrowLeft') next = resize ? { ...roi, w: roi.w - dx } : { ...roi, x: roi.x - dx }
    else if (event.key === 'ArrowRight') next = resize ? { ...roi, w: roi.w + dx } : { ...roi, x: roi.x + dx }
    else if (event.key === 'ArrowUp') next = resize ? { ...roi, h: roi.h - dy } : { ...roi, y: roi.y - dy }
    else if (event.key === 'ArrowDown') next = resize ? { ...roi, h: roi.h + dy } : { ...roi, y: roi.y + dy }
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    const clamped = clampRoi(next, minimum)
    latestRef.current = clamped
    onChange(clamped)
    onCommit?.(clamped)
  }

  if (box.width <= 0 || box.height <= 0) return null

  const style: React.CSSProperties = {
    left: `${box.x + roi.x * box.width}px`,
    top: `${box.y + roi.y * box.height}px`,
    width: `${Math.max(2, roi.w * box.width)}px`,
    height: `${Math.max(2, roi.h * box.height)}px`,
    ...(bodyDraggable ? {} : { cursor: 'crosshair' }),
  }

  const sizeText = unit === 'percent'
    ? `${Math.round(roi.w * 100)}%×${Math.round(roi.h * 100)}%`
    : `${Math.round(roi.w * videoWidth)}×${Math.round(roi.h * videoHeight)}`
  const showHandles = !readOnly && (variant !== 'mask' || selected)

  return (
    <div
      className={`roi-window${variant === 'mask' ? ' roi-window--mask' : ''}${selected ? ' is-selected' : ''}${readOnly ? ' is-readonly' : ''}`}
      data-field={label}
      aria-readonly={readOnly}
      style={style}
      role="group"
      aria-label={ariaLabel ?? (readOnly ? `${label ?? '字段'}识别区域，只读` : '识别区域，方向键移动，Alt+方向键缩放')}
      tabIndex={readOnly ? undefined : 0}
      onFocus={readOnly ? undefined : onSelect}
      onKeyDown={readOnly ? undefined : onKeyDown}
      onPointerDown={bodyDraggable ? beginDrag('move') : undefined}
      onPointerMove={bodyDraggable ? continueDrag : undefined}
      onPointerUp={bodyDraggable ? endDrag : undefined}
      onPointerCancel={bodyDraggable ? endDrag : undefined}
      onLostPointerCapture={bodyDraggable ? endDrag : undefined}
    >
      {showHandles && HANDLES.map((handle) => (
        <span
          key={handle}
          className={`roi-handle roi-handle-${handle}`}
          data-handle={handle}
          onPointerDown={beginDrag(handle)}
          onPointerMove={continueDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
      <span className="roi-size">
        {label ? `${label} ` : ''}{sizeText}
      </span>
    </div>
  )
}

/** Keep at least one picture pixel, including tiny high-resolution HUD regions. */
function clampRoi(roi: RoiRect, minimum: Pick<RoiRect, 'w' | 'h'>): RoiRect {
  const w = Math.max(minimum.w, roi.w)
  const h = Math.max(minimum.h, roi.h)
  return normalizeRoi({
    x: Math.min(Math.max(0, roi.x), 1 - w),
    y: Math.min(Math.max(0, roi.y), 1 - h),
    w,
    h,
  })
}

/**
 * Apply a drag delta.
 *
 * Edge drags move the edge and compensate the origin, so the opposite edge stays put —
 * dragging the left handle right must not slide the whole box.
 */
function applyDrag(origin: RoiRect, mode: Handle | 'move', dx: number, dy: number, minimum: Pick<RoiRect, 'w' | 'h'>): RoiRect {
  if (mode === 'move') {
    return clampRoi({ ...origin, x: origin.x + dx, y: origin.y + dy }, minimum)
  }
  let { x, y, w, h } = origin
  if (mode.includes('w')) {
    const shift = Math.min(dx, w - minimum.w)
    x += shift
    w -= shift
  }
  if (mode.includes('e')) w += dx
  if (mode.includes('n')) {
    const shift = Math.min(dy, h - minimum.h)
    y += shift
    h -= shift
  }
  if (mode.includes('s')) h += dy
  return clampRoi({ x, y, w, h }, minimum)
}
