/**
 * Which picture is the commentary showing right now?
 *
 * Each picture (the current one and every backup) gets its own frame-hash sampler paired with
 * the commentary video. A comparison asks every sampler for an estimate and keeps the
 * confidences; `bestCandidate` decides whether a backup clearly beats the current picture, and
 * `CandidateStreak` only lets a decision through after it repeated, so one lucky match never
 * swaps the picture.
 */

import type { SourceRole } from '../core/types'
import type { FrameHashConfig } from './frameHashProtocol'
import { FrameHashSampler, type FrameMeasureRequest, type FrameMeasurement } from './frameHashSampler'

/** The key under which the picture currently loaded as `official` is scored. */
export const CURRENT_PICTURE = 'current'

export interface PictureScore { key: string; confidence: number | null }

/** Lowest confidence a backup needs before it can win at all. */
export const CANDIDATE_FLOOR = 0.35
/** How much a backup has to beat the current picture by. */
export const CANDIDATE_MARGIN = 0.15

/**
 * The backup that clearly matches the commentary better than the current picture, or null.
 * A current picture without an estimate counts as zero, so a failing picture is easy to beat.
 */
export function bestCandidate(current: number | null, candidates: readonly PictureScore[],
  margin = CANDIDATE_MARGIN, floor = CANDIDATE_FLOOR): string | null {
  let best: PictureScore | null = null
  for (const score of candidates) {
    if (score.confidence === null || !Number.isFinite(score.confidence)) continue
    if (!best || score.confidence > best.confidence!) best = score
  }
  if (!best || best.confidence! < floor) return null
  return best.confidence! >= (current ?? 0) + margin ? best.key : null
}

/** Passes a winner on only once it won `required` comparisons in a row. */
export class CandidateStreak {
  private last: string | null = null
  private count = 0
  constructor(private readonly required = 2) {}

  observe(winner: string | null): string | null {
    if (winner === null || winner !== this.last) {
      this.last = winner
      this.count = winner === null ? 0 : 1
    } else this.count += 1
    if (winner === null || this.count < this.required) return null
    this.reset()
    return winner
  }

  reset(): void {
    this.last = null
    this.count = 0
  }
}

export interface MatcherPicture {
  key: string
  video: HTMLVideoElement
  revision(): string
}

export interface PictureSampler {
  measure(request: FrameMeasureRequest): Promise<FrameMeasurement>
  dispose(): void
}

interface SamplerSpec {
  video(role: SourceRole): HTMLVideoElement
  revision(role: SourceRole): string
  config(): FrameHashConfig
}

export interface CandidateMatcherOptions {
  commentary(): HTMLVideoElement
  commentaryRevision(): string
  config(): FrameHashConfig
  /** Tests replace the worker-backed sampler. */
  createSampler?: (spec: SamplerSpec) => PictureSampler
}

/** How long each picture is watched during one comparison. */
const COMPARE_WINDOW_MS = 6000

export class CandidateMatcher {
  private readonly samplers = new Map<string, { video: HTMLVideoElement; sampler: PictureSampler }>()
  private disposed = false

  constructor(private readonly options: CandidateMatcherOptions) {}

  /** Keep exactly one sampler per listed picture; a picture whose element changed starts over. */
  sync(pictures: readonly MatcherPicture[]): void {
    if (this.disposed) return
    const wanted = new Map(pictures.map(picture => [picture.key, picture]))
    for (const [key, entry] of [...this.samplers]) {
      if (wanted.get(key)?.video === entry.video) continue
      entry.sampler.dispose()
      this.samplers.delete(key)
    }
    for (const picture of pictures) {
      if (this.samplers.has(picture.key)) continue
      const spec: SamplerSpec = {
        video: role => role === 'official' ? picture.video : this.options.commentary(),
        revision: role => role === 'official' ? picture.revision() : this.options.commentaryRevision(),
        config: () => this.options.config(),
      }
      const sampler = this.options.createSampler?.(spec)
        ?? new FrameHashSampler({ ...spec, onStatus: () => {} })
      this.samplers.set(picture.key, { video: picture.video, sampler })
    }
  }

  get size(): number { return this.samplers.size }

  /** Score every picture against the commentary, one after another to keep the load flat. */
  async compare(signal: { readonly aborted: boolean }): Promise<{ current: number | null; scores: PictureScore[] }> {
    let current: number | null = null
    const scores: PictureScore[] = []
    for (const [key, entry] of [...this.samplers]) {
      if (signal.aborted || this.disposed) break
      let confidence: number | null = null
      try {
        const result = await entry.sampler.measure({ windowMs: COMPARE_WINDOW_MS, appliedOffsetSeconds: 0, fresh: false, signal })
        confidence = result.estimate?.confidence ?? null
      } catch { confidence = null }
      if (key === CURRENT_PICTURE) current = confidence
      else scores.push({ key, confidence })
    }
    return { current, scores }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.samplers.values()) entry.sampler.dispose()
    this.samplers.clear()
  }
}
