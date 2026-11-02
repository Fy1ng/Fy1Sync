/** Imported style packs share a full-frame capture path. */
import type { HudStylePack } from './hudStylePack'
import type { RecognitionProfile, RoiRect } from './profileSchema'

export type ActiveProfile = HudStylePack | RecognitionProfile

export function isHudPack(profile: ActiveProfile): profile is HudStylePack {
  return 'kind' in profile && profile.kind === 'hud-style-pack'
}

export function captureRoi(profile: ActiveProfile): RoiRect {
  return isHudPack(profile) ? { x: 0, y: 0, w: 1, h: 1 } : profile.roi
}
