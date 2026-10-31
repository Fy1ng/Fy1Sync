/** Mask score primitives retained for diagnostics. Recognition runs in Rust/WASM. */
export function scoreMasks(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0
  let union = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const inkA = (a[index] ?? 0) !== 0
    const inkB = (b[index] ?? 0) !== 0
    if (inkA && inkB) intersection += 1
    if (inkA || inkB) union += 1
  }
  return union === 0 ? 0 : intersection / union
}

/**
 * IoU generalised to partial ink: sum(min) / sum(max).
 *
 * For two binary masks this is identical to `scoreMasks` — min is set only where
 * both are inked, max only where either is — so stored templates keep matching
 * exactly as before. The difference appears when the live glyph carries coverage
 * fractions: a boundary pixel at 60% contributes 0.6 to the intersection instead
 * of an all-or-nothing 1 or 0.
 *
 * That is the whole reason this exists. The same digit resampled one row taller
 * between two frames used to lose ~0.19 of its score, enough to fall under a 0.82
 * threshold while the runner-up sat at 0.49 — the match was right and the gate was
 * measuring the resampling grid rather than the shape.
 */
export function scoreCoverage(coverage: Uint8Array, template: Uint8Array): number {
  let intersection = 0
  let union = 0
  const length = Math.min(coverage.length, template.length)
  for (let index = 0; index < length; index += 1) {
    const a = coverage[index] ?? 0
    const b = (template[index] ?? 0) !== 0 ? 255 : 0
    intersection += a < b ? a : b
    union += a > b ? a : b
  }
  return union === 0 ? 0 : intersection / union
}


export type { HudGlyphMatch as GlyphMatch } from './hudWasm'
