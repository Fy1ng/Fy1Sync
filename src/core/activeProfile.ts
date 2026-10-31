/** Session-only learned clocks are never accepted as imported style packs. */
import { createEmptyHudStylePack, type HudSize, type HudStylePack } from './hudStylePack'
import type { RecognitionProfile, RoiRect } from './profileSchema'

export type ActiveProfile = HudStylePack | RecognitionProfile

export function isHudPack(profile: ActiveProfile): profile is HudStylePack {
  return 'kind' in profile && profile.kind === 'hud-style-pack'
}

/** Layouts are chosen per frame, but a pack with none at this size can never read the video. */
export function assertLayoutForSize(pack: HudStylePack, size: HudSize): void {
  if (!pack.variants.some(item => item.nativeSize.width === size.width && item.nativeSize.height === size.height)) {
    throw new Error(`样式包没有 ${size.width}x${size.height} 的布局档`)
  }
}

export function captureRoi(profile: ActiveProfile): RoiRect {
  return isHudPack(profile) ? { x: 0, y: 0, w: 1, h: 1 } : profile.roi
}

/** Convert trusted live learning output at an explicit native frame size. */
export function learnedClockPack(profile: RecognitionProfile, size: HudSize): HudStylePack {
  const pack = createEmptyHudStylePack(profile.id, profile.name, size)
  const clock = pack.variants[0]!.fields.clock!
  const x = Math.round(profile.roi.x * size.width)
  const y = Math.round(profile.roi.y * size.height)
  clock.roi = { x, y, w: Math.min(size.width - x, Math.max(1, Math.round(profile.roi.w * size.width))),
    h: Math.min(size.height - y, Math.max(1, Math.round(profile.roi.h * size.height))) }
  clock.preprocess = { ...profile.preprocess }
  clock.grammar = { kind: 'countdown', format: profile.clockFormat === 'auto' ? 'm:ss' : profile.clockFormat }
  clock.match.minScore = profile.matchThreshold
  for (const [char, samples] of Object.entries(profile.templates)) {
    const refs = samples.map((sample, index) => {
      const id = `clock-${char === ':' ? 'colon' : char}-${index}`
      pack.bitmaps[id] = { width: 32, height: 48, data: sample.data }
      return id
    })
    if (refs.length) clock.glyphs[char as keyof typeof clock.glyphs] = refs
  }
  return pack
}
