/**
 * Lane allocation for scrolling danmaku.
 *
 * All scrolling messages share one pixel speed. With equal speed a message can
 * never catch up to the one ahead of it, so a lane is reusable as soon as the
 * previous message's tail has fully cleared the right edge. That single
 * condition (`freeAt`) is all the allocator needs to track.
 */

export type DanmakuMode = 'scroll' | 'top' | 'bottom'

/** Fraction of the video height danmaku may occupy. */
export type DanmakuArea = 'quarter' | 'half' | 'full'

export const AREA_FRACTION: Record<DanmakuArea, number> = {
  quarter: 0.25,
  half: 0.5,
  full: 1,
}

export interface LaneLayout {
  /** Height of one lane in px (font size + gap). */
  laneHeight: number
  /** Usable height in px for danmaku. */
  areaHeight: number
  /** Container width in px. */
  width: number
  /** Scroll speed in px/s. */
  speed: number
}

export interface LaneAssignment {
  lane: number
  /** Top offset in px inside the container. */
  top: number
  /** Seconds the message needs to cross the container. */
  durationSeconds: number
}

export class DanmakuLaneAllocator {
  /** Wall time (seconds) each lane becomes reusable. */
  private freeAt: number[] = []
  private layout: LaneLayout

  constructor(layout: LaneLayout) {
    this.layout = layout
    this.resizeLanes()
  }

  setLayout(layout: LaneLayout): void {
    this.layout = layout
    this.resizeLanes()
  }

  get laneCount(): number {
    return this.freeAt.length
  }

  reset(): void {
    this.freeAt = this.freeAt.map(() => 0)
  }

  /**
   * Reserve a lane for a scrolling message.
   * Returns `null` when every lane is still busy — the caller drops the message
   * rather than stacking it on top of another one.
   */
  allocateScroll(now: number, messageWidth: number): LaneAssignment | null {
    const { width, speed, laneHeight } = this.layout
    if (this.freeAt.length === 0 || speed <= 0) return null

    const travel = width + messageWidth
    const durationSeconds = travel / speed
    // The tail clears the right edge once the message has moved its own width.
    const clearTime = now + messageWidth / speed

    let chosen = -1
    let earliest = Number.POSITIVE_INFINITY
    for (let lane = 0; lane < this.freeAt.length; lane += 1) {
      const free = this.freeAt[lane] ?? 0
      if (free <= now) {
        chosen = lane
        break
      }
      if (free < earliest) {
        earliest = free
        chosen = -1
      }
    }
    if (chosen < 0) return null

    this.freeAt[chosen] = clearTime
    return { lane: chosen, top: chosen * laneHeight, durationSeconds }
  }

  /** Lanes a message could take right now. */
  freeLanes(now: number): number {
    let free = 0
    for (const at of this.freeAt) if (at <= now) free += 1
    return free
  }

  /**
   * Messages on screen changed speed by `1 / factor`: what is left of each lane's wait
   * scales with them (their remaining distance is the same).
   */
  rescale(now: number, factor: number): void {
    this.freeAt = this.freeAt.map((at) => (at > now ? now + (at - now) * factor : at))
  }

  /** Push every busy lane back, e.g. by the width a narrower picture lost. */
  delay(seconds: number): void {
    if (seconds > 0) this.freeAt = this.freeAt.map((at) => (at > 0 ? at + seconds : at))
  }

  /** The message in `lane` grew; its tail clears the edge `seconds` later. */
  extend(lane: number, seconds: number): void {
    const at = this.freeAt[lane]
    if (at !== undefined && seconds > 0) this.freeAt[lane] = at + seconds
  }

  private resizeLanes(): void {
    const { areaHeight, laneHeight } = this.layout
    const count = laneHeight > 0 ? Math.max(1, Math.floor(areaHeight / laneHeight)) : 1
    if (count === this.freeAt.length) return
    const next = new Array<number>(count).fill(0)
    for (let lane = 0; lane < Math.min(count, this.freeAt.length); lane += 1) {
      next[lane] = this.freeAt[lane] ?? 0
    }
    this.freeAt = next
  }
}

/**
 * Pinned (top/bottom) danmaku use a small independent stack of slots that each
 * hold one message for a fixed dwell time.
 */
export class PinnedSlotAllocator {
  private freeAt: number[]

  constructor(slots: number) {
    this.freeAt = new Array<number>(Math.max(1, slots)).fill(0)
  }

  setSlots(slots: number): void {
    const count = Math.max(1, slots)
    if (count === this.freeAt.length) return
    const next = new Array<number>(count).fill(0)
    for (let slot = 0; slot < Math.min(count, this.freeAt.length); slot += 1) {
      next[slot] = this.freeAt[slot] ?? 0
    }
    this.freeAt = next
  }

  allocate(now: number, dwellSeconds: number): number | null {
    for (let slot = 0; slot < this.freeAt.length; slot += 1) {
      if ((this.freeAt[slot] ?? 0) <= now) {
        this.freeAt[slot] = now + dwellSeconds
        return slot
      }
    }
    return null
  }

  reset(): void {
    this.freeAt = this.freeAt.map(() => 0)
  }
}

/** Rough text width for where nothing is laid out (tests); the overlays measure the node. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    units += code > 0x2e80 ? 1 : 0.55
  }
  return Math.ceil(units * fontSize)
}
