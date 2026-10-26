/**
 * Draggable/resizable ROI window drawn over the sample video.
 *
 * Coordinates are the interesting part. The ROI is stored as fractions of the *picture*,
 * not of the element, because the same profile has to work at any window size and the
 * recognition worker only ever sees frame pixels. A `object-fit: contain` video leaves
 * letterbox bars, so every conversion goes through `contentRect` — without it, resizing
 * the window would silently move the ROI relative to the scoreboard.
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
  videoWidth,
  videoHeight,
  /** Element the ROI is drawn over; used to measure the painted picture box. */
  hostRef,
}: {
  roi: RoiRect
  onChange: (roi: RoiRect) => void
  videoWidth: number
  videoHeight: number
  hostRef: React.RefObject<HTMLDivElement | null>
}): React.ReactNode {
  const [box, setBox] = useState<Rect>({ x: 0, y: 0, width: 0, height: 0 })
  const dragRef = useRef<DragState | null>(null)

  // The picture box changes on resize, on fullscreen, and when metadata finally tells us
  // the intrinsic size. A ResizeObserver covers the first two; `videoWidth` in the dep
  // list covers the third.
  useEffect(() => {
    const host = hostRef.current
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
    if (box.width <= 0 || box.height <= 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
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
    onChange(applyDrag(drag.origin, drag.mode, dx, dy))
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (box.width <= 0) return
    const step = event.shiftKey ? NUDGE_PX_FAST : NUDGE_PX
    const dx = step / box.width
    const dy = step / box.height
    const resize = event.altKey
    let next: RoiRect | null = null
    if (event.key === 'ArrowLeft') next = resize ? { ...roi, w: roi.w - dx } : { ...roi, x: roi.x - dx }
    else if (event.key === 'ArrowRight') next = resize ? { ...roi, w: roi.w + dx } : { ...roi, x: roi.x + dx }
    else if (event.key === 'ArrowUp') next = resize ? { ...roi, h: roi.h - dy } : { ...roi, y: roi.y - dy }
    else if (event.key === 'ArrowDown') next = resize ? { ...roi, h: roi.h + dy } : { ...roi, y: roi.y + dy }
    if (!next) return
    event.preventDefault()
    onChange(clampRoi(next))
  }

  if (box.width <= 0 || box.height <= 0) return null

  const style: React.CSSProperties = {
    left: `${box.x + roi.x * box.width}px`,
    top: `${box.y + roi.y * box.height}px`,
    width: `${Math.max(2, roi.w * box.width)}px`,
    height: `${Math.max(2, roi.h * box.height)}px`,
  }

  return (
    <div
      className="roi-window"
      style={style}
      role="group"
      aria-label="识别区域，方向键移动，Alt+方向键缩放"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={beginDrag('move')}
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {HANDLES.map((handle) => (
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
        {Math.round(roi.w * videoWidth)}×{Math.round(roi.h * videoHeight)}
      </span>
    </div>
  )
}

/** Minimum ROI, as a fraction. Below this the window cannot be grabbed again. */
const MIN_FRACTION = 0.01

function clampRoi(roi: RoiRect): RoiRect {
  const w = Math.max(MIN_FRACTION, roi.w)
  const h = Math.max(MIN_FRACTION, roi.h)
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
function applyDrag(origin: RoiRect, mode: Handle | 'move', dx: number, dy: number): RoiRect {
  if (mode === 'move') {
    return clampRoi({ ...origin, x: origin.x + dx, y: origin.y + dy })
  }
  let { x, y, w, h } = origin
  if (mode.includes('w')) {
    const shift = Math.min(dx, w - MIN_FRACTION)
    x += shift
    w -= shift
  }
  if (mode.includes('e')) w += dx
  if (mode.includes('n')) {
    const shift = Math.min(dy, h - MIN_FRACTION)
    y += shift
    h -= shift
  }
  if (mode.includes('s')) h += dy
  return clampRoi({ x, y, w, h })
}
