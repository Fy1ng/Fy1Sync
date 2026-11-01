import { describe, expect, it } from 'vitest'
import { hudRoiAtSize } from './hudGeometry'

describe('HUD reference coordinates', () => {
  it('keeps native coordinates exact and scales to any positive decoded size', () => {
    const roi = Object.freeze({ x: 100, y: 40, w: 240, h: 80 })
    const reference = { width: 1920, height: 1080 }
    expect(hudRoiAtSize(roi, reference, reference)).toEqual(roi)
    expect(hudRoiAtSize(roi, reference, { width: 3840, height: 2160 })).toEqual({ x: 200, y: 80, w: 480, h: 160 })
    expect(hudRoiAtSize(roi, reference, { width: 1280, height: 720 })).toEqual({ x: 67, y: 27, w: 160, h: 53 })
    expect(hudRoiAtSize(roi, reference, { width: 960, height: 1080 })).toEqual({ x: 50, y: 40, w: 120, h: 80 })
  })

  it('keeps subpixel edge regions inside small frames', () => {
    expect(hudRoiAtSize({ x: 3839, y: 2159, w: 1, h: 1 }, { width: 3840, height: 2160 }, { width: 320, height: 180 }))
      .toEqual({ x: 319, y: 179, w: 1, h: 1 })
  })

  it('rejects missing or invalid coordinate sizes without prescribing resolution presets', () => {
    for (const width of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => hudRoiAtSize({ x: 0, y: 0, w: 1, h: 1 }, { width: 640, height: 360 }, { width, height: 100 })).toThrow()
    }
  })
})
