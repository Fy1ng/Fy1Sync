/**
 * Where each extra stream's window sits. Rectangles are in pixels of the theater; a stored
 * rectangle is clamped on the way out rather than rewritten, so a window shrunk by a narrow
 * moment comes back to its size when the theater grows again.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Bounds { w: number; h: number }
export type Layout = Record<string, Rect>

export const MIN_SIZE = { w: 220, h: 160 } as const
export const DEFAULT_SIZE = { w: 352, h: 262 } as const
/** Enough for the backend's default of 16 extra streams with room to spare. */
export const MAX_ENTRIES = 32
const STORAGE_KEY = 'studio.extraStreams.layout.v1'
const CASCADE = 28
const TOP_CLEARANCE = 64
const EDGE = 20

/** Keep a rectangle inside the theater. A zero-sized theater (not yet measured) clamps nothing. */
export function clampRect(rect: Rect, bounds: Bounds): Rect {
  if (bounds.w <= 0 || bounds.h <= 0) return rect
  const w = Math.min(Math.max(rect.w, Math.min(MIN_SIZE.w, bounds.w)), bounds.w)
  const h = Math.min(Math.max(rect.h, Math.min(MIN_SIZE.h, bounds.h)), bounds.h)
  return {
    x: Math.min(Math.max(rect.x, 0), bounds.w - w),
    y: Math.min(Math.max(rect.y, 0), bounds.h - h),
    w,
    h,
  }
}

/** The nth new window steps down and left from the top right, below the top bar. */
export function defaultRect(index: number, bounds: Bounds): Rect {
  const step = (index % 6) * CASCADE
  const { w, h } = DEFAULT_SIZE
  const x = bounds.w > 0 ? bounds.w - w - EDGE - step : EDGE + step
  return clampRect({ x, y: TOP_CLEARANCE + step, w, h }, bounds)
}

/** Move by a pointer delta, then keep it inside. */
export function movedRect(start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds)
}

/** Grow or shrink from the bottom-right corner; the top-left corner stays put. */
export function resizedRect(start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  let w = Math.max(MIN_SIZE.w, start.w + dx)
  let h = Math.max(MIN_SIZE.h, start.h + dy)
  if (bounds.w > 0) w = Math.min(w, bounds.w - Math.max(start.x, 0))
  if (bounds.h > 0) h = Math.min(h, bounds.h - Math.max(start.y, 0))
  return clampRect({ ...start, w, h }, bounds)
}

const isRect = (value: unknown): value is Rect => {
  if (!value || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'w', 'h'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
}

function storage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

export function readLayout(): Layout {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const layout: Layout = {}
    for (const [id, rect] of Object.entries(parsed).slice(-MAX_ENTRIES)) {
      if (/^stream-[a-f0-9]{32}$/.test(id) && isRect(rect)) layout[id] = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
    }
    return layout
  } catch {
    return {}
  }
}

export function writeLayout(layout: Layout): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(boundLayout(layout))) } catch { /* Quota or privacy mode: positions just do not persist. */ }
}

/** Keep the most recently inserted entries when over the cap. */
export function boundLayout(layout: Layout): Layout {
  const entries = Object.entries(layout)
  return entries.length <= MAX_ENTRIES ? layout : Object.fromEntries(entries.slice(-MAX_ENTRIES))
}

/** Drop the windows of streams that are gone. Returns the same object when nothing changed. */
export function pruneLayout(layout: Layout, live: ReadonlySet<string>): Layout {
  const kept = Object.entries(layout).filter(([id]) => live.has(id))
  return kept.length === Object.keys(layout).length ? layout : Object.fromEntries(kept)
}
