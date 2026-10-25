/**
 * Danmaku timeline.
 *
 * A danmaku is never shown when it arrives. It is parked on a timeline keyed by
 * the *commentary media time* the message belongs to, and only released once
 * playback reaches that time. Because the commentary source is the one that gets
 * rewound to match the official picture, scheduling against its media time makes
 * the overlay inherit the sync offset for free: rewind the commentary by 5s and
 * every danmaku shows up 5s later, in step with the picture.
 *
 * The timeline is deliberately dumb about wall clock. The caller decides which
 * media time a message maps to (see `scheduleTimeFor`) and then pumps the
 * timeline with the current media time on every frame.
 */

import type { DouyuGiftMetadata, DouyuSenderMetadata } from './types'

export interface DanmakuMessage {
  id: string
  text: string
  user: string
  color: string
  /** Commentary media time (seconds) at which this message should appear. */
  scheduleTime: number
  /** Wall clock (ms) the message was received, for debugging only. */
  receivedAt: number
  /** Only public server facts. A local identity badge is a separate render decision. */
  sender?: DouyuSenderMetadata
  /** Present only for an actual gift event, never for a chat text that mentions gifts. */
  gift?: DouyuGiftMetadata
  dms?: number
  duplicateGroupId?: string
  duplicateCount?: number
}

export interface DanmakuTimelineOptions {
  /**
   * Messages scheduled more than this many seconds behind the playhead are
   * dropped instead of shown, so a long seek forward does not dump a wall of
   * stale danmaku on screen.
   */
  maxLagSeconds?: number
  /** Hard cap on parked messages; oldest are discarded first. */
  capacity?: number
}

export interface DanmakuTimelineStats {
  pending: number
  released: number
  expired: number
  overflowed: number
}

const DEFAULT_MAX_LAG_SECONDS = 8
const DEFAULT_CAPACITY = 2000

export class DanmakuTimeline {
  private readonly maxLagSeconds: number
  private readonly capacity: number
  private pending: DanmakuMessage[] = []
  private cursor = 0
  private released = 0
  private expired = 0
  private overflowed = 0

  constructor(options: DanmakuTimelineOptions = {}) {
    this.maxLagSeconds = options.maxLagSeconds ?? DEFAULT_MAX_LAG_SECONDS
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
  }

  /** Park a message. Insertion keeps `pending` sorted by `scheduleTime`. */
  push(message: DanmakuMessage): void {
    const index = this.upperBound(message.scheduleTime)
    this.pending.splice(index, 0, message)
    if (this.pending.length > this.capacity) {
      const dropped = this.pending.length - this.capacity
      this.pending.splice(0, dropped)
      this.overflowed += dropped
    }
  }

  /**
   * Release every message whose `scheduleTime` has been reached.
   * Messages that fell too far behind the playhead are counted as expired and
   * never returned.
   */
  advance(mediaTime: number): DanmakuMessage[] {
    if (!Number.isFinite(mediaTime)) return []
    const ready: DanmakuMessage[] = []
    let index = 0
    while (index < this.pending.length) {
      const message = this.pending[index]
      if (!message || message.scheduleTime > mediaTime) break
      if (mediaTime - message.scheduleTime > this.maxLagSeconds) {
        this.expired += 1
      } else {
        ready.push(message)
      }
      index += 1
    }
    if (index > 0) this.pending.splice(0, index)
    this.released += ready.length
    this.cursor = mediaTime
    return ready
  }

  /**
   * A backwards seek (manual sync rewind) means the picture is now showing
   * earlier content. Anything already released stays released — it cannot be
   * un-shown — but the timeline must not treat the new, smaller media time as a
   * forward jump and expire the queue.
   */
  handleSeek(mediaTime: number): void {
    if (!Number.isFinite(mediaTime)) return
    this.cursor = mediaTime
  }

  clear(): void {
    this.pending = []
  }

  reset(): void {
    this.pending = []
    this.cursor = 0
    this.released = 0
    this.expired = 0
    this.overflowed = 0
  }

  get playhead(): number {
    return this.cursor
  }

  stats(): DanmakuTimelineStats {
    return {
      pending: this.pending.length,
      released: this.released,
      expired: this.expired,
      overflowed: this.overflowed,
    }
  }

  private upperBound(scheduleTime: number): number {
    let low = 0
    let high = this.pending.length
    while (low < high) {
      const mid = (low + high) >> 1
      const candidate = this.pending[mid]
      if (candidate && candidate.scheduleTime <= scheduleTime) low = mid + 1
      else high = mid
    }
    return low
  }
}

/**
 * Map a just-arrived danmaku to a commentary media time.
 *
 * Live: the message was written by viewers watching the commentary live edge, so
 * that is the media time it belongs to. When the commentary has been rewound for
 * sync, `currentTime` sits behind `seekableEnd` and the message correctly waits
 * out the difference.
 *
 * VOD/file: there is no live edge, so the message belongs to "now" and shows up
 * after one pump.
 */
export function scheduleTimeFor(snapshot: {
  currentTime: number
  timebase: { kind: 'vod' | 'live'; seekableEnd?: number }
}): number {
  if (snapshot.timebase.kind === 'live' && Number.isFinite(snapshot.timebase.seekableEnd ?? NaN)) {
    return snapshot.timebase.seekableEnd as number
  }
  return snapshot.currentTime
}
