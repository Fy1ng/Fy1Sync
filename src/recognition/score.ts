import type { SourceRole } from '../core/types'

/** Numeric score evidence only. Pixel buffers never enter the history. */
export interface ScorePixels {
  left: number | null
  right: number | null
  leftQuality: number
  rightQuality: number
  reason: string | null
  style?: string | null
}
export interface ScoreReading extends ScorePixels {
  mediaTime: number
  wallTime: number
  source: string
  generation: number
  width: number
  height: number
  segment: number
  frameIndex: number
}
export interface ScoreGuardRequest {
  residualSeconds: number
  signal: { aborted: boolean }
}
export interface ScoreGuardResult {
  status: 'pass' | 'mismatch' | 'unknown' | 'transition'
  official?: ScoreReading
  commentary?: ScoreReading
  reason?: string
  checkedAt: number
  generation: string
}

export const UNKNOWN_SCORE: ScorePixels = {
  left: null, right: null, leftQuality: 0, rightQuality: 0, reason: 'score-unsupported',
}

const MAX_AGE_MS = 90_000
const MAX_RECORDS = 400
const MAX_GAP_MS = 1250
const BOUNDARY_MS = 2000

function complete(value: ScoreReading): boolean {
  return Number.isInteger(value.left) && Number.isInteger(value.right)
    && value.left! >= 0 && value.left! <= 99 && value.right! >= 0 && value.right! <= 99
    && Number.isFinite(value.leftQuality) && value.leftQuality > 0
    && Number.isFinite(value.rightQuality) && value.rightQuality > 0
    && value.reason === null
}
function same(a: ScoreReading, b: ScoreReading): boolean {
  return a.left === b.left && a.right === b.right
}

/** Source-local, bounded evidence, invalidated by the owner on every discontinuity. */
export class ScoreHistory {
  private records: Record<SourceRole, ScoreReading[]> = { official: [], commentary: [] }

  clear(role: SourceRole): void { this.records[role] = [] }
  readings(role: SourceRole): readonly ScoreReading[] { return this.records[role] }

  push(role: SourceRole, reading: ScoreReading): void {
    if (!Number.isFinite(reading.mediaTime) || !Number.isFinite(reading.wallTime)) return
    let entries = this.records[role]
    const last = entries.at(-1)
    if (last && (last.source !== reading.source || last.generation !== reading.generation
      || last.width !== reading.width || last.height !== reading.height || last.segment !== reading.segment)) {
      this.clear(role)
      entries = this.records[role]
    } else if (last && (reading.mediaTime <= last.mediaTime || reading.wallTime <= last.wallTime)) return
    entries.push({ ...reading })
    const cutoff = reading.wallTime - MAX_AGE_MS
    while (entries.length > MAX_RECORDS || (entries[0]?.wallTime ?? Infinity) < cutoff) entries.shift()
  }

  evaluate(residualSeconds: number, now: number, generation: string): ScoreGuardResult {
    const finish = (status: ScoreGuardResult['status'], reason?: string,
      official?: ScoreReading, commentary?: ScoreReading): ScoreGuardResult => ({
      status, reason, official, commentary, checkedAt: now, generation,
    })
    if (!Number.isFinite(residualSeconds) || Math.abs(residualSeconds) > 60) return finish('unknown', 'invalid-offset')
    const o = this.records.official
    const c = this.records.commentary
    const lastO = o.at(-1)
    const lastC = c.at(-1)
    if (!lastO || !lastC) return finish('unknown', 'history-insufficient', lastO, lastC)
    if (now - lastO.wallTime > MAX_GAP_MS || now - lastC.wallTime > MAX_GAP_MS) {
      return finish('unknown', 'stale-score', lastO, lastC)
    }
    const delta = residualSeconds * 1000
    const oShift = Math.max(0, delta)
    const cShift = Math.max(0, -delta)
    // Leave observed evidence on both sides of a possible score update.
    const anchor = Math.min(lastO.wallTime + oShift, lastC.wallTime + cShift) - BOUNDARY_MS
    const targetO = anchor - oShift
    const targetC = anchor - cShift
    const window = (entries: readonly ScoreReading[], target: number): {
      reading?: ScoreReading; status: 'stable' | 'missing' | 'transition'; reason?: string
    } => {
      const selected = entries.filter(value => value.wallTime >= target - BOUNDARY_MS
        && value.wallTime <= target + BOUNDARY_MS)
      if (selected.length < 3 || selected[0]!.wallTime > target - 1000
        || selected.at(-1)!.wallTime < target + 1000) return { status: 'missing' }
      const nearest = selected.reduce((a, b) => Math.abs(a.wallTime - target) <= Math.abs(b.wallTime - target) ? a : b)
      const unreadable = selected.find(value => !complete(value))
      if (unreadable) return { reading: nearest, status: 'missing', reason: unreadable.reason ?? 'score-unreadable' }
      if (selected.some(value => !same(value, nearest))) return { reading: nearest, status: 'transition' }
      for (let index = 1; index < selected.length; index += 1) {
        if (selected[index]!.wallTime - selected[index - 1]!.wallTime > MAX_GAP_MS) return { reading: nearest, status: 'missing' }
      }
      if (selected.at(-1)!.mediaTime - selected[0]!.mediaTime < 0.99) return { reading: nearest, status: 'missing' }
      return { reading: nearest, status: 'stable' }
    }
    const ow = window(o, targetO)
    const cw = window(c, targetC)
    if (ow.status === 'transition' || cw.status === 'transition') {
      return finish('transition', 'score-transition', ow.reading, cw.reading)
    }
    if (ow.status === 'missing' || cw.status === 'missing') {
      return finish('unknown', ow.reason ?? cw.reason ?? 'history-insufficient', ow.reading ?? lastO, cw.reading ?? lastC)
    }
    return finish(same(ow.reading!, cw.reading!) ? 'pass' : 'mismatch', undefined, ow.reading, cw.reading)
  }
}
