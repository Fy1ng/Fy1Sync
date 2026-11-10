/** Automatic clocks and imported style packs share a full-frame capture path. */
import type { HudStylePack } from './hudStylePack'
import type { RecognitionProfile, RoiRect } from './profileSchema'

export interface BasicClockProfile {
  kind: 'basic-clock'
  id: 'basic-clock'
  name: string
  sampleFps: number
  /** Fractions of the full source frame; capture remains full-frame for preview alignment. */
  roi?: RoiRect
  roiOrigin?: 'manual' | 'memory'
  /** Discovery is bounded to this region unless an exact manual or remembered ROI is set. */
  searchRoi?: RoiRect
}

export const BASIC_CLOCK_PROFILE: BasicClockProfile = {
  kind: 'basic-clock', id: 'basic-clock', name: '基础模式', sampleFps: 15,
}

export type ActiveProfile = HudStylePack | RecognitionProfile | BasicClockProfile

export function isBasicClock(profile: ActiveProfile): profile is BasicClockProfile {
  return 'kind' in profile && profile.kind === 'basic-clock'
}

export function isHudPack(profile: ActiveProfile): profile is HudStylePack {
  return 'kind' in profile && profile.kind === 'hud-style-pack'
}

export function captureRoi(profile: ActiveProfile): RoiRect {
  return isHudPack(profile) || isBasicClock(profile) ? { x: 0, y: 0, w: 1, h: 1 } : profile.roi
}
