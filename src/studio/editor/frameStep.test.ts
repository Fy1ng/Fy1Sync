import { describe, expect, it, vi } from 'vitest'
import { FrameStepper, type PresentAt } from './frameStep'

/** A file whose frames start at `times`: a seek presents the last frame starting at or before it. */
function file(times: number[]): { present: PresentAt; seeks: number[] } {
  const seeks: number[] = []
  const present: PresentAt = async (time) => {
    seeks.push(time)
    let shown = times[0]!
    for (const start of times) if (start <= time + 1e-9) shown = start
    return shown
  }
  return { present, seeks }
}

/** `count` frames at `fps`, from `start`, rounded to the millisecond as containers store them. */
const frames = (fps: number, count: number, start = 0) =>
  Array.from({ length: count }, (_, index) => Math.round((start + index / fps) * 1000) / 1000)

describe('FrameStepper', () => {
  it.each([[60], [63], [30], [25]])('steps through every frame of a %i fps file, in both directions', async (fps) => {
    const times = frames(fps, 40)
    const { present } = file(times)
    const stepper = new FrameStepper(present)
    let at = times[5]!
    for (let index = 6; index < 30; index++) {
      at = await stepper.step(at, 1, 10)
      expect(at).toBe(times[index])
    }
    for (let index = 28; index >= 10; index--) {
      at = await stepper.step(at, -1, 10)
      expect(at).toBe(times[index])
    }
  })

  it('needs one seek a step once it has seen a frame', async () => {
    const times = frames(63, 40)
    const { present, seeks } = file(times)
    const stepper = new FrameStepper(present)
    let at = times[3]!
    at = await stepper.step(at, 1, 10)
    seeks.length = 0
    for (let i = 0; i < 10; i++) at = await stepper.step(at, 1, 10)
    expect(seeks).toHaveLength(10)
    for (let i = 0; i < 10; i++) at = await stepper.step(at, -1, 10)
    expect(seeks).toHaveLength(20)
  })

  it('finds a longer frame after a short one (variable frame rate)', async () => {
    const times = [0, 0.016, 0.033, 0.1, 0.116, 0.133]
    const { present } = file(times)
    const stepper = new FrameStepper(present)
    expect(await stepper.step(0.016, 1, 1)).toBe(0.033)
    expect(await stepper.step(0.033, 1, 1)).toBe(0.1)
    expect(await stepper.step(0.1, 1, 1)).toBe(0.116)
    expect(await stepper.step(0.1, -1, 1)).toBe(0.033)
  })

  it('stays put at either end of the file', async () => {
    const times = frames(60, 10)
    const present = vi.fn(file(times).present)
    const stepper = new FrameStepper(present)
    expect(await stepper.step(0, -1, 0.15)).toBe(0)
    expect(await stepper.step(times[9]!, 1, times[9]! + 0.001)).toBe(times[9])
  })

  it('learns a new file from scratch after reset', async () => {
    let current = file(frames(25, 20))
    const stepper = new FrameStepper((time) => current.present(time))
    expect(await stepper.step(0.04, 1, 10)).toBe(0.08)
    // A 60 fps file next: the 25 fps gap (40 ms) would jump two of its frames at a time.
    const fast = frames(60, 20)
    current = file(fast)
    stepper.reset()
    expect(await stepper.step(fast[2]!, 1, 10)).toBe(fast[3])
    expect(await stepper.step(fast[3]!, 1, 10)).toBe(fast[4])
  })
})
