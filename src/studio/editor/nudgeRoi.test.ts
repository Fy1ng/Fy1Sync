import { describe, expect, it } from 'vitest'
import { nudgeRoi } from './rail'

const size = { width: 3840, height: 2160 }
/** The region as the pack stores it: whole native pixels, rounded from the fractions. */
const pixels = (roi: { x: number; y: number; w: number; h: number }) => ({
  x: Math.round(roi.x * size.width), y: Math.round(roi.y * size.height),
  w: Math.round(roi.w * size.width), h: Math.round(roi.h * size.height),
})
const clock = { x: 1854 / 3840, y: 98 / 2160, w: 116 / 3840, h: 64 / 2160 }

describe('one-pixel region nudges', () => {
  it('moves or resizes one edge by exactly one native pixel', () => {
    expect(pixels(nudgeRoi(clock, 'x', 1, size))).toEqual({ x: 1855, y: 98, w: 116, h: 64 })
    expect(pixels(nudgeRoi(clock, 'y', -1, size))).toEqual({ x: 1854, y: 97, w: 116, h: 64 })
    expect(pixels(nudgeRoi(clock, 'w', 1, size))).toEqual({ x: 1854, y: 98, w: 117, h: 64 })
    expect(pixels(nudgeRoi(clock, 'h', -1, size))).toEqual({ x: 1854, y: 98, w: 116, h: 63 })
  })

  it('steps from the stored pixel, not the unrounded fraction', () => {
    // A dragged box sits between pixels; one press must reach the next whole pixel, not stay put.
    const dragged = { ...clock, x: 1854.4 / 3840 }
    expect(pixels(nudgeRoi(dragged, 'x', 1, size)).x).toBe(1855)
    expect(pixels(nudgeRoi(dragged, 'x', -1, size)).x).toBe(1853)
  })

  it('changes only its own value and stops at the picture edge', () => {
    const corner = { x: 0, y: 0, w: 1 / 3840, h: 1 / 2160 }
    expect(pixels(nudgeRoi(corner, 'x', -1, size))).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(pixels(nudgeRoi(corner, 'w', -1, size))).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    const edge = { x: 3724 / 3840, y: 0, w: 116 / 3840, h: 64 / 2160 }
    expect(pixels(nudgeRoi(edge, 'x', 1, size)).x).toBe(3724)
    expect(pixels(nudgeRoi(edge, 'w', 1, size))).toEqual({ x: 3724, y: 0, w: 116, h: 64 })
    expect(pixels(nudgeRoi(edge, 'w', -1, size))).toEqual({ x: 3724, y: 0, w: 115, h: 64 })
  })

  it('leaves the region alone before a frame size is known', () => {
    expect(nudgeRoi(clock, 'x', 1, { width: 0, height: 0 })).toBe(clock)
  })
})
