import type { UpscaleTier } from './plan'

/** Both sustained overload and the recent ratio must agree before lowering a tier. */
export class DegradeController {
  private consecutive = 0
  private recent: boolean[] = []
  private current: UpscaleTier

  constructor(tier: UpscaleTier, private readonly sustained = 30, private readonly window = 60, private readonly ratio = 0.8) {
    this.current = tier
  }

  get tier(): UpscaleTier { return this.current }

  observe(milliseconds: number, frameInterval: number): UpscaleTier | null {
    if (this.current === 'off' || !Number.isFinite(milliseconds) || milliseconds < 0 || !Number.isFinite(frameInterval) || frameInterval <= 0) return null
    const overloaded = milliseconds > frameInterval
    this.consecutive = overloaded ? this.consecutive + 1 : 0
    this.recent.push(overloaded)
    if (this.recent.length > this.window) this.recent.shift()
    if (this.consecutive < this.sustained || this.recent.length < this.window
      || this.recent.filter(Boolean).length / this.window < this.ratio) return null
    this.current = this.current === 'quality' ? 'performance' : 'off'
    this.consecutive = 0
    this.recent = []
    return this.current
  }
}
