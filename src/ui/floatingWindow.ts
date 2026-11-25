/**
 * Stage-relative geometry for aspect-locked floating windows (camera overlay and secondary
 * preview). Coordinates are stored as fractions of the stage so window resizes, fullscreen
 * and sidebar toggles preserve proportional placement.
 */

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Fired when a small window begins dragging or resizing so any held danmaku menu releases immediately. */
export const RELEASE_DANMAKU_HOVER_EVENT = 'studio:release-danmaku-hover'

/** Minimum pointer movement in pixels before a press over danmaku or preview becomes a window drag. */
export const DRAG_THRESHOLD_PX = 4

export interface StageSize {
  width: number
  height: number
}

export interface AspectWindow {
  /** Top-left position as fractions of stage width and height. */
  x: number
  y: number
  /** Width as a fraction of stage width; height follows `aspect`. */
  width: number
}

export interface WidthBounds {
  min: number
  max: number
}

const clampNum = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Clamp an aspect-locked window so its entire box stays inside the stage. */
export function clampAspectWindow<W extends AspectWindow>(
  win: W,
  stage: StageSize,
  aspect: number,
  bounds: WidthBounds = { min: 0.08, max: 0.6 },
): W {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const baseWidth = Number.isFinite(win.width) ? clampNum(win.width, bounds.min, bounds.max) : bounds.min
  const baseX = Number.isFinite(win.x) ? clampNum(win.x, 0, 0.95) : 0
  const baseY = Number.isFinite(win.y) ? clampNum(win.y, 0, 0.95) : 0
  if (stage.width <= 0 || stage.height <= 0) {
    return { ...win, x: baseX, y: baseY, width: baseWidth }
  }
  const heightFraction = (baseWidth * stage.width / safeAspect) / stage.height
  // Shrink to fit when a tall aspect ratio would exceed 95% of stage height even within width bounds.
  const width = heightFraction > 0.95 ? baseWidth * (0.95 / heightFraction) : baseWidth
  const h = Math.min(0.95, heightFraction)
  return {
    ...win,
    width,
    x: clampNum(baseX, 0, Math.max(0, 1 - width)),
    y: clampNum(baseY, 0, Math.max(0, 1 - h)),
  }
}

/**
 * Resize an aspect-locked window from any of the 8 edges or corners.
 *
 * Corner drags keep the opposite corner anchored; edge drags keep the opposite edge anchored
 * and expand symmetrically around the perpendicular center. Hitting a stage edge stops growth
 * rather than sliding the anchored edge.
 */
export function resizeAspectWindow<W extends AspectWindow>(
  origin: W,
  handle: ResizeHandle,
  dxPx: number,
  dyPx: number,
  stage: StageSize,
  aspect: number,
  bounds: WidthBounds = { min: 0.08, max: 0.6 },
): W {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  if (stage.width <= 0 || stage.height <= 0) return origin

  const stageW = stage.width
  const stageH = stage.height
  const left0 = origin.x * stageW
  const top0 = origin.y * stageH
  const w0 = origin.width * stageW
  const h0 = w0 / safeAspect
  const right0 = left0 + w0
  const bottom0 = top0 + h0
  const cx0 = left0 + w0 / 2
  const cy0 = top0 + h0 / 2

  const maxWByStage = Math.min(bounds.max * stageW, 0.95 * stageH * safeAspect, stageW)
  const minW = Math.min(bounds.min * stageW, maxWByStage)

  let left = left0
  let top = top0
  let w = w0

  if (handle === 'e') {
    const maxW = Math.max(minW, Math.min(maxWByStage, stageW - left0))
    w = clampNum(w0 + dxPx, minW, maxW)
    const h = w / safeAspect
    left = left0
    top = clampNum(cy0 - h / 2, 0, Math.max(0, stageH - h))
  } else if (handle === 'w') {
    const maxW = Math.max(minW, Math.min(maxWByStage, right0))
    w = clampNum(w0 - dxPx, minW, maxW)
    const h = w / safeAspect
    left = right0 - w
    top = clampNum(cy0 - h / 2, 0, Math.max(0, stageH - h))
  } else if (handle === 's') {
    const maxW = Math.max(minW, Math.min(maxWByStage, (stageH - top0) * safeAspect))
    w = clampNum((h0 + dyPx) * safeAspect, minW, maxW)
    top = top0
    left = clampNum(cx0 - w / 2, 0, Math.max(0, stageW - w))
  } else if (handle === 'n') {
    const maxW = Math.max(minW, Math.min(maxWByStage, bottom0 * safeAspect))
    w = clampNum((h0 - dyPx) * safeAspect, minW, maxW)
    const h = w / safeAspect
    top = bottom0 - h
    left = clampNum(cx0 - w / 2, 0, Math.max(0, stageW - w))
  } else {
    const signX = handle.includes('e') ? 1 : -1
    const signY = handle.includes('s') ? 1 : -1
    const outX = signX * dxPx
    const outY = signY * dyPx * safeAspect
    const deltaW = Math.abs(outX) >= Math.abs(outY) ? outX : outY
    const roomX = handle.includes('e') ? stageW - left0 : right0
    const roomY = (handle.includes('s') ? stageH - top0 : bottom0) * safeAspect
    const maxW = Math.max(minW, Math.min(maxWByStage, roomX, roomY))
    w = clampNum(w0 + deltaW, minW, maxW)
    const h = w / safeAspect
    left = handle.includes('e') ? left0 : right0 - w
    top = handle.includes('s') ? top0 : bottom0 - h
  }

  return clampAspectWindow(
    { ...origin, x: left / stageW, y: top / stageH, width: w / stageW },
    stage,
    safeAspect,
    bounds,
  )
}
