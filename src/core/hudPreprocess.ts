/** The complete portable preprocessing configuration for HUD digits and fixed graphics. */
export interface HudPreprocessSettings {
  mode: 'gray' | 'adaptive' | 'hsv'
  scale: number
  threshold: number
  invert: boolean
  adaptive: { windowSize: number; offset: number }
  hsv: { hue: number; tolerance: number; saturationMin: number; saturationMax: number; valueMin: number; valueMax: number }
}

export function createHudPreprocess(overrides: Partial<HudPreprocessSettings> = {}): HudPreprocessSettings {
  return { mode: 'gray', scale: 1.4, threshold: 150, invert: false,
    adaptive: { windowSize: 15, offset: 7 },
    hsv: { hue: 0, tolerance: 15, saturationMin: 0.25, saturationMax: 1, valueMin: 0.03, valueMax: 1 },
    ...overrides }
}

export type HudPreprocessRequest = { kind: 'threshold' | 'polarity' } | { kind: 'hsv'; x: number; y: number }
export interface HudPreprocessRecommendation { settings: HudPreprocessSettings | null; reason: string | null }
