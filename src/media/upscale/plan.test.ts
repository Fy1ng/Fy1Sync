import { describe, expect, it } from 'vitest'
import { outputSize, passPlan } from './plan'

describe('camera output sizing', () => {
  it('uses display pixels and preserves aspect under the long-side cap', () => {
    expect(outputSize(300.2, 200.1, 2)).toEqual({ width: 600, height: 400 })
    expect(outputSize(1920, 1080, 2)).toEqual({ width: 2560, height: 1440 })
    expect(outputSize(1080, 1920, 2)).toEqual({ width: 1440, height: 2560 })
    expect(outputSize(0, Number.NaN, Number.NaN)).toEqual({ width: 1, height: 1 })
  })

  it('does no SR on an equal-size or downscaled crop', () => {
    expect(passPlan('performance', { width: 640, height: 480 }, { width: 640, height: 480 }).passes).toEqual(['crop', 'bilinear'])
    expect(passPlan('quality', { width: 640, height: 480 }, { width: 320, height: 240 }).passes).toEqual(['crop', 'bilinear'])
    expect(passPlan('off', { width: 100, height: 100 }, { width: 400, height: 400 }).passes).toEqual([])
  })

  it('skips CNN for small scaling and resamples a 2x CNN output', () => {
    const crop = { width: 100, height: 100 }
    expect(passPlan('quality', crop, { width: 120, height: 120 }).passes).toEqual(['crop', 'easu', 'rcas'])
    expect(passPlan('quality', crop, { width: 150, height: 150 }).passes).toEqual(['crop', 'cnn', 'bilinear'])
    expect(passPlan('quality', crop, { width: 300, height: 300 }).passes).toEqual(['crop', 'cnn', 'easu', 'rcas'])
    expect(passPlan('performance', crop, { width: 300, height: 300 }).passes).toEqual(['crop', 'easu', 'rcas'])
  })

  it('upscales when either output axis exceeds its source axis', () => {
    expect(passPlan('quality', { width: 200, height: 100 }, { width: 100, height: 150 }).passes).toContain('cnn')
  })
})
