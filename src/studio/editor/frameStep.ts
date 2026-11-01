/**
 * Step a paused video one real frame at a time.
 *
 * `currentTime` is only a request: the decoder presents whichever frame covers it, and a
 * file's frame rate is not something the page is told (a Douyu recording runs at 63 fps,
 * not 60). So a step seeks a little past the frame on screen, reads back the frame that was
 * actually presented (`requestVideoFrameCallback`'s `mediaTime`), and nudges further only
 * if that is still the same one. The gap between two presented frames is remembered; once
 * known, one seek lands each step.
 */

/** Seek to `time` and resolve with the media time of the frame that seek presented. */
export type PresentAt = (time: number) => Promise<number>

/** Two presented times closer than this are the same frame. */
const SAME = 1e-4
/** First guess at a frame's length, before one has been seen: half a 60 fps frame. */
const FIRST_GUESS = 0.008
/** How far each retry creeps when a seek lands on the frame already shown. */
const CREEP = 0.004
const MAX_TRIES = 40

export class FrameStepper {
  /** Shortest gap seen between two adjacent presented frames, 0 until one is seen. */
  private gap = 0

  constructor(private readonly present: PresentAt) {}

  /** Forget the learned gap: a new file has its own frame rate. */
  reset(): void { this.gap = 0 }

  /**
   * The frame `direction` frames away from the one presented at `from` (−1 or +1), or
   * `from` itself at either end of the file. Resolves with the presented media time.
   */
  async step(from: number, direction: -1 | 1, duration: number): Promise<number> {
    const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity
    // Forward, 1.5 gaps lands inside the next frame; back, half a gap lands inside the
    // previous one. Either way a frame of a different length is still found by creeping.
    let probe = direction > 0
      ? from + (this.gap > 0 ? this.gap * 1.5 : FIRST_GUESS)
      : from - (this.gap > 0 ? this.gap / 2 : FIRST_GUESS)
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      if (probe < 0 || probe > end) return from
      const landed = await this.present(Math.max(0, Math.min(end, probe)))
      const moved = direction > 0 ? landed > from + SAME : landed < from - SAME
      if (moved) {
        const gap = Math.abs(landed - from)
        // Only an adjacent frame teaches the gap; a landing two frames away would not.
        if (this.gap === 0 || gap < this.gap) this.gap = gap
        return landed
      }
      probe += direction * CREEP
    }
    return from
  }
}

/**
 * The real `PresentAt` for a `<video>`: seek, and wait for the frame that seek presents.
 * Falls back to `seeked` where `requestVideoFrameCallback` is missing (jsdom), which gives
 * the requested time rather than the presented one.
 */
export function presentAt(video: HTMLVideoElement): PresentAt {
  return (time) => new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback((_now, metadata) => resolve(metadata.mediaTime))
    } else {
      video.addEventListener('seeked', () => resolve(video.currentTime), { once: true })
    }
    video.currentTime = time
  })
}
