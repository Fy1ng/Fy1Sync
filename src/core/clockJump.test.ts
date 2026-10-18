import { describe, expect, it } from 'vitest'
import { ClockJumpDetector, parseCountdown } from './clockJump'
import type { RecognitionOutcome } from './types'

function reading(
  text: string,
  frameIndex: number,
  options: { confidence?: number; mediaTime?: number; wallTime?: number } = {},
): RecognitionOutcome {
  const seconds = parseCountdown(text) ?? Number.NaN
  return {
    status: 'success',
    reading: {
      text,
      seconds,
      scores: [1],
      confidence: options.confidence ?? 0.95,
      mediaTime: options.mediaTime ?? frameIndex / 30,
      wallTime: options.wallTime ?? frameIndex * (1000 / 30),
      frameIndex,
    },
  }
}

/** Feed a countdown value for `frames` consecutive frames starting at `startFrame`. */
function feed(
  detector: ClockJumpDetector,
  text: string,
  startFrame: number,
  frames: number,
  options: { confidence?: number; mediaTimeOffset?: number } = {},
) {
  const events = []
  for (let index = 0; index < frames; index += 1) {
    const frameIndex = startFrame + index
    const mediaTime = frameIndex / 30 + (options.mediaTimeOffset ?? 0)
    const result = detector.push(
      reading(text, frameIndex, {
        confidence: options.confidence,
        mediaTime,
        wallTime: mediaTime * 1000,
      }),
    )
    events.push(result)
  }
  return events
}

describe('parseCountdown', () => {
  it('parses m:ss and mm:ss', () => {
    expect(parseCountdown('0:45')).toBe(45)
    expect(parseCountdown('00:45')).toBe(45)
    expect(parseCountdown('1:05')).toBe(65)
    expect(parseCountdown('12:00')).toBe(720)
  })

  it('rejects malformed countdowns instead of guessing', () => {
    expect(parseCountdown('')).toBeNull()
    expect(parseCountdown('0:61')).toBeNull()
    expect(parseCountdown('::')).toBeNull()
    expect(parseCountdown('4:5')).toBeNull()
    expect(parseCountdown('abc')).toBeNull()
  })

  it('honours an explicit format', () => {
    expect(parseCountdown('0:45', 'mm:ss')).toBeNull()
    expect(parseCountdown('00:45', 'mm:ss')).toBe(45)
    expect(parseCountdown('45', 'ss')).toBe(45)
    expect(parseCountdown('00:45', 'ss')).toBeNull()
  })
})

describe('ClockJumpDetector', () => {
  it('emits a jump when the countdown decreases by exactly one second', () => {
    const detector = new ClockJumpDetector('official')
    expect(feed(detector, '00:46', 0, 3).every((result) => result.event === null)).toBe(true)

    const results = feed(detector, '00:45', 30, 3)
    const emitted = results.filter((result) => result.event !== null)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.event).toMatchObject({
      source: 'official',
      from: '00:46',
      to: '00:45',
      toSeconds: 45,
      frameIndex: 30,
    })
    expect(emitted[0]!.event!.mediaTime).toBeCloseTo(1, 5)
  })

  it('anchors the jump to the first frame showing the new value', () => {
    const detector = new ClockJumpDetector('commentary', { stableFrames: 3 })
    feed(detector, '01:00', 0, 4)
    const results = feed(detector, '00:59', 30, 4)
    const event = results.find((result) => result.event)?.event
    expect(event?.frameIndex).toBe(30)
    expect(event?.mediaTime).toBeCloseTo(1, 5)
  })

  it('drops round resets and loop wrap-arounds', () => {
    const detector = new ClockJumpDetector('official')
    feed(detector, '00:01', 0, 3)
    const wrap = feed(detector, '01:55', 30, 3)
    expect(wrap.some((result) => result.event !== null)).toBe(false)
    expect(wrap.some((result) => result.dropped === 'not-decrement')).toBe(true)
  })

  it('drops skipped seconds', () => {
    const detector = new ClockJumpDetector('official')
    feed(detector, '00:46', 0, 3)
    const skipped = feed(detector, '00:44', 30, 3)
    expect(skipped.some((result) => result.event !== null)).toBe(false)
    expect(skipped.some((result) => result.dropped === 'not-decrement')).toBe(true)
  })

  it('ignores low-confidence frames without treating them as a change', () => {
    const detector = new ClockJumpDetector('official', { minConfidence: 0.8 })
    feed(detector, '00:46', 0, 3)
    const noisy = feed(detector, '00:12', 30, 3, { confidence: 0.4 })
    expect(noisy.every((result) => result.event === null)).toBe(true)
    expect(noisy.every((result) => result.dropped === 'low-confidence')).toBe(true)

    const good = feed(detector, '00:45', 60, 3)
    expect(good.some((result) => result.event !== null)).toBe(true)
  })

  it('ignores failed recognition frames', () => {
    const detector = new ClockJumpDetector('official')
    feed(detector, '00:46', 0, 3)
    expect(detector.push({ status: 'failed', reason: 'blank-frame' }).event).toBeNull()
    const results = feed(detector, '00:45', 30, 3)
    expect(results.some((result) => result.event !== null)).toBe(true)
  })

  it('drops jumps whose spacing is impossible for a one-second countdown', () => {
    const detector = new ClockJumpDetector('official', { jumpIntervalRange: [0.4, 2.5] })
    feed(detector, '00:47', 0, 3)
    expect(feed(detector, '00:46', 30, 3).some((result) => result.event)).toBe(true)
    // Next jump arrives 4 media-seconds later: the source stalled.
    const stalled = feed(detector, '00:45', 150, 3)
    expect(stalled.some((result) => result.event !== null)).toBe(false)
    expect(stalled.some((result) => result.dropped === 'abnormal-interval')).toBe(true)
  })

  it('requires the configured number of stable frames', () => {
    const detector = new ClockJumpDetector('official', { stableFrames: 4 })
    feed(detector, '00:46', 0, 5)
    expect(feed(detector, '00:45', 30, 3).some((result) => result.event)).toBe(false)
    expect(feed(detector, '00:45', 33, 1).some((result) => result.event)).toBe(true)
  })

  it('needs no jump for the very first observed value', () => {
    const detector = new ClockJumpDetector('official')
    expect(feed(detector, '00:45', 0, 5).some((result) => result.event)).toBe(false)
  })

  it('clears state on reset', () => {
    const detector = new ClockJumpDetector('official')
    feed(detector, '00:46', 0, 3)
    detector.reset()
    expect(feed(detector, '00:45', 30, 3).some((result) => result.event)).toBe(false)
  })
})
