import { contentRect, type Rect } from '../../core/imageOps'
import type { RoiRect } from '../../core/profileSchema'

export interface Size { width: number; height: number }
export interface StageView { zoom: number; cx: number; cy: number }
export const FIT_VIEW: StageView = { zoom: 1, cx: 0.5, cy: 0.5 }
const MAX_PIXEL_SCALE = 4

export function fitScale(media: Size, viewport: Size): number {
  return media.width > 0 && media.height > 0
    ? Math.min(viewport.width / media.width, viewport.height / media.height) : 0
}

export function pictureRect(media: Size, viewport: Size, view: StageView): Rect {
  const fit = contentRect(media.width, media.height, viewport.width, viewport.height)
  const width = fit.width * view.zoom
  const height = fit.height * view.zoom
  return { x: viewport.width / 2 - view.cx * width, y: viewport.height / 2 - view.cy * height, width, height }
}

function boundedView(zoom: number, cx: number, cy: number): StageView {
  return zoom <= 1 ? FIT_VIEW : { zoom, cx: Math.max(0, Math.min(1, cx)), cy: Math.max(0, Math.min(1, cy)) }
}

/** Keep the picture fraction under the cursor stationary while changing scale. */
export function zoomAt(media: Size, viewport: Size, view: StageView, factor: number, point: { x: number; y: number }): StageView {
  const scale = fitScale(media, viewport)
  if (scale <= 0) return FIT_VIEW
  const zoom = Math.max(1, Math.min(Math.max(1, MAX_PIXEL_SCALE / scale), view.zoom * factor))
  const rect = pictureRect(media, viewport, view)
  return boundedView(zoom,
    (point.x - rect.x) / rect.width + (viewport.width / 2 - point.x) / (rect.width * zoom / view.zoom),
    (point.y - rect.y) / rect.height + (viewport.height / 2 - point.y) / (rect.height * zoom / view.zoom))
}

export function panView(view: StageView, rect: Rect, dx: number, dy: number): StageView {
  return boundedView(view.zoom, view.cx - dx / rect.width, view.cy - dy / rect.height)
}

export function focusRoi(media: Size, viewport: Size, roi: RoiRect): StageView {
  const scale = fitScale(media, viewport)
  if (scale <= 0 || roi.w <= 0 || roi.h <= 0) return FIT_VIEW
  const target = Math.min(MAX_PIXEL_SCALE, viewport.width * 0.8 / (roi.w * media.width), viewport.height * 0.8 / (roi.h * media.height))
  return boundedView(Math.max(1, target / scale), roi.x + roi.w / 2, roi.y + roi.h / 2)
}
