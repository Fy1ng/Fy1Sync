/** Per-source media-time sampling rhythm. No timers or wall-clock assumptions. */
export interface RhythmOptions {
  windowSeconds?: number
  sparseFps?: number
  intervalRange?: readonly [number, number]
}

export class RhythmSampler {
  private readonly window: number
  private readonly sparseInterval: number
  private readonly intervalRange: readonly [number, number]
  private lastTick: number | null = null
  private period: number | null = null
  private lastFrame: number | null = null
  private lastSample: number | null = null

  constructor(options: RhythmOptions = {}) {
    this.window = options.windowSeconds ?? 0.15
    this.sparseInterval = 1 / (options.sparseFps ?? 4)
    this.intervalRange = options.intervalRange ?? [0.65, 1.35]
  }

  get mode(): 'dense' | 'predicted' {
    return this.period === null ? 'dense' : 'predicted'
  }

  get nextTick(): number | null {
    return this.lastTick === null || this.period === null ? null : this.lastTick + this.period
  }

  reset(): void {
    this.lastTick = null
    this.period = null
    this.lastFrame = null
    this.lastSample = null
  }

  /** Only confirmed countdown decrements may establish or update the rhythm. */
  confirmTick(mediaTime: number): void {
    if (!Number.isFinite(mediaTime)) {
      this.reset()
      return
    }
    if (this.lastTick !== null) {
      const interval = mediaTime - this.lastTick
      const [min, max] = this.intervalRange
      // A skipped tick, round reset or duplicate must not predict the next second.
      this.period = interval >= min && interval <= max ? interval : null
    }
    this.lastTick = mediaTime
  }

  shouldSample(mediaTime: number): boolean {
    if (!Number.isFinite(mediaTime)) return false
    if (this.lastFrame !== null) {
      if (mediaTime === this.lastFrame) return false
      // rVFC runs on every presented frame even when recognition is sparse.
      if (mediaTime < this.lastFrame || mediaTime - this.lastFrame > 0.5) this.reset()
    }
    this.lastFrame = mediaTime
    const next = this.nextTick
    if (next !== null && mediaTime > next + this.window) {
      // The predicted transition was never confirmed. Reacquire from actual frames.
      this.reset()
      this.lastFrame = mediaTime
    }
    const predicted = this.nextTick
    const dense = predicted === null || Math.abs(mediaTime - predicted) <= this.window + 1e-9
    if (dense || this.lastSample === null || mediaTime - this.lastSample >= this.sparseInterval - 1e-9) {
      this.lastSample = mediaTime
      return true
    }
    return false
  }
}
