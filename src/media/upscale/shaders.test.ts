import { describe, expect, it } from 'vitest'
import { BILINEAR_WGSL, CROP_WGSL, VERTEX_WGSL } from './shaders'

describe('camera WGSL boundaries', () => {
  it('samples a zero-copy external video texture in the crop pass', () => {
    expect(CROP_WGSL).toContain('texture_external')
    expect(CROP_WGSL).toContain('textureSampleBaseClampToEdge')
    expect(CROP_WGSL).toContain('params.cropOrigin')
    expect(CROP_WGSL).toContain('params.cropSize / params.outputSize')
  })

  it('keeps all raster passes on the same fullscreen entrypoints', () => {
    expect(VERTEX_WGSL).toContain('@vertex fn vertexMain')
    expect(CROP_WGSL).toContain('@fragment fn fragmentMain')
    expect(BILINEAR_WGSL).toContain('@fragment fn fragmentMain')
    expect(BILINEAR_WGSL).toContain('clamp(p, vec2i(0)')
  })
})
