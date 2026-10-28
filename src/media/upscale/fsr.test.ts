import { describe, expect, it } from 'vitest'
import { FSR_WGSL } from './fsr'

describe('FSR WGSL module contract', () => {
  it('exports reusable RGB EASU and RCAS helpers without owning GPU bindings or entry points', () => {
    expect(FSR_WGSL).toContain('fn easu(position: vec2f) -> vec3f')
    expect(FSR_WGSL).toContain('fn rcas(position: vec2i) -> vec3f')
    expect(FSR_WGSL).toContain('params.inputSize / params.outputSize')
    expect(FSR_WGSL).not.toMatch(/@(?:group|binding|fragment|compute|vertex)\b/)
    expect(FSR_WGSL).not.toMatch(/\b(?:sampler2D|vec[234]\(|uintBitsToFloat|#define)\b/)
  })

  it('keeps the twelve-tap anisotropic kernel, deringing, and bounded RCAS sharpening', () => {
    const easu = FSR_WGSL.slice(FSR_WGSL.indexOf('fn easu('), FSR_WGSL.indexOf('fn rcas('))
    expect(easu.match(/fsrEasuTap\(/g)).toHaveLength(12)
    expect(easu.match(/fsrEasuSet\(/g)).toHaveLength(4)
    expect(easu).toContain('clamp(sum.rgb / sum.a, minimum, maximum)')
    expect(FSR_WGSL).toContain('exp2(-0.2) * denoise')
    expect(FSR_WGSL).toContain('max(-0.1875,')
  })
})
