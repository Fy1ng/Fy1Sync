import { describe, expect, it } from 'vitest'
import { CNN_M_PASSES, CNN_M_WEIGHTS, CNN_PASSES, CNN_S_WEIGHTS } from './anime4k'

describe('Anime4K real-life shader graph', () => {
  it('retains the S and M exported tensor shapes and finite signed weights', () => {
    expect(CNN_S_WEIGHTS.map((layer) => layer.weights.length)).toEqual([144, 288, 288, 288])
    expect(CNN_M_WEIGHTS.map((layer) => layer.weights.length)).toEqual([144, 288, 288, 288, 288, 288, 288, 224, 224, 224])
    for (const layer of [...CNN_S_WEIGHTS, ...CNN_M_WEIGHTS]) {
      expect(layer.bias.length).toBe(4)
      expect(Array.from(layer.weights).every(Number.isFinite)).toBe(true)
      expect(layer.weights.some((value) => value < 0)).toBe(true)
    }
    expect(CNN_S_WEIGHTS[0]?.weights[0]).toBeCloseTo(-0.25782192, 7)
  })

  it('uses native signed feature maps followed by exactly one 2x shuffle', () => {
    expect(CNN_PASSES.map((pass) => pass.scale)).toEqual([1, 1, 1, 1, 2])
    expect(CNN_M_PASSES.map((pass) => pass.scale)).toEqual([...Array<number>(10).fill(1), 2])
    for (const passes of [CNN_PASSES, CNN_M_PASSES]) {
      passes.forEach((pass, index) => {
        expect(pass.inputs.every((input) => input >= -1 && input < index)).toBe(true)
        expect(pass.wgsl).toContain('@fragment fn fragmentMain')
        expect(pass.wgsl).toContain('textureDimensions')
        expect(pass.wgsl).not.toContain('@binding(0)')
        expect(pass.wgsl).not.toMatch(/NaN|undefined|Infinity/)
        expect(pass.wgsl.match(/@binding\(/g)?.length).toBe(pass.inputs.length)
      })
    }
    expect(CNN_PASSES[1]?.wgsl).toContain('max(-pixel0, vec4f(0.0))')
    expect(CNN_PASSES[1]?.wgsl).not.toContain('clamp(result')
    expect(CNN_PASSES.at(-1)?.inputs).toEqual([-1, 3])
    expect(CNN_M_PASSES.at(-1)?.inputs).toEqual([-1, 7, 8, 9])
  })

  it('keeps 2x depth-to-space phase and an opaque bilinear residual base', () => {
    const shuffle = CNN_PASSES.at(-1)?.wgsl ?? ''
    expect(shuffle).toContain('outputPixel.x % 2 + (outputPixel.y % 2) * 2')
    expect(shuffle).toContain('position.xy * 0.5 - vec2f(0.5)')
    expect(shuffle).toContain('original + vec3f(load1(coord)[channel])')
    expect(shuffle).toContain('vec3f(1.0)), 1.0)')
  })
})
