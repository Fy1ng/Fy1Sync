export interface FrameFingerprint { hashes: (number | null)[]; detail: Float32Array; valid: Uint8Array }
export interface HashFrame { pts: number; fp: FrameFingerprint }
export interface HashMatch {
  status: 'ok' | 'rejected'; reason?: string; offset?: number; residual?: number; span?: number;
  confidence?: number; temporalCorrelation?: number; uncertainty?: number;
  pairs?: { a: number; b: number; cost: number }[]
}
export function fingerprint(gray: Uint8Array, masks?: { x: number; y: number; width: number; height: number }[]): FrameFingerprint
export function matchFrames(a: HashFrame[], b: HashFrame[], options?: {
  minSpan?: number; stepTolerance?: number; maxCoarse?: number; maxDetail?: number; minTemporalCorrelation?: number; temporalStep?: number;
}): HashMatch
export const WIDTH: number
export const HEIGHT: number
