import { createEmptyHudStylePack, type HudSize, type HudStylePack } from '../core/hudStylePack'
import type { RecognitionProfile } from '../core/profileSchema'
import { createHudPreprocess } from '../core/hudPreprocess'

/** Convert explicit legacy test vectors into manually supplied HUD fixture packs. */
export function manualPackFixture(profile: RecognitionProfile, size: HudSize): HudStylePack {
  const pack = createEmptyHudStylePack(profile.id, profile.name, size)
  const clock = pack.variants[0]!.fields.clock!
  const x = Math.round(profile.roi.x * size.width)
  const y = Math.round(profile.roi.y * size.height)
  clock.roi = { x, y, w: Math.min(size.width - x, Math.max(1, Math.round(profile.roi.w * size.width))),
    h: Math.min(size.height - y, Math.max(1, Math.round(profile.roi.h * size.height))) }
  clock.preprocess = createHudPreprocess(profile.preprocess)
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
