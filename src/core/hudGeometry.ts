import type { HudRoi, HudSize } from './hudStylePack'

/** Match Rust's reference-to-frame ROI mapping, including one-pixel edge regions. */
export function hudRoiAtSize(roi: HudRoi, reference: HudSize, frame: HudSize): HudRoi {
  if (![reference.width, reference.height, frame.width, frame.height].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('参考尺寸和画面尺寸必须是正整数.')
  }
  const sx = frame.width / reference.width, sy = frame.height / reference.height
  const x = Math.max(0, Math.min(frame.width - 1, Math.round(roi.x * sx)))
  const y = Math.max(0, Math.min(frame.height - 1, Math.round(roi.y * sy)))
  return { x, y, w: Math.max(1, Math.min(frame.width - x, Math.round(roi.w * sx))),
    h: Math.max(1, Math.min(frame.height - y, Math.round(roi.h * sy))) }
}
