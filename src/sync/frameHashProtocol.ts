import type { SourceRole } from '../core/types'
import type { RoiRect } from '../core/profileSchema'
import type { HashMatch } from './frameHashCore.mjs'

export interface FrameHashConfig { regions: Record<SourceRole, RoiRect>; masks: RoiRect[] }
export type HashRequest =
  | { type: 'reset'; role?: SourceRole }
  | { type: 'fresh'; since: number }
  | { type: 'frame'; role: SourceRole; pts: number; wall: number; epoch: string; width: number; height: number; pixels: Uint8ClampedArray; masks: RoiRect[] }
  | { type: 'match'; id: number; fresh: boolean }
export type HashResponse =
  | { type: 'ack'; role: SourceRole }
  | { type: 'result'; id: number; match: HashMatch; counts: Record<SourceRole, number>; coarse: boolean }
  | { type: 'error'; message: string }
