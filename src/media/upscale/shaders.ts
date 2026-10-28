/** Shared fullscreen rasterization and the external-video crop. No decoded frame copy. */
export const VERTEX_WGSL = /* wgsl */ `
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(points[index], 0.0, 1.0);
}
`

export const PARAMS_WGSL = /* wgsl */ `
struct Params { cropSize: vec2f, outputSize: vec2f, inputSize: vec2f, cropOrigin: vec2f, videoSize: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
`

export const CROP_WGSL = PARAMS_WGSL + /* wgsl */ `
@group(0) @binding(1) var source: texture_external;
@group(0) @binding(2) var linearSampler: sampler;
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = (params.cropOrigin + position.xy * params.cropSize / params.outputSize) / params.videoSize;
  return vec4f(textureSampleBaseClampToEdge(source, linearSampler, uv).rgb, 1.0);
}
`

export const LOAD_WGSL = PARAMS_WGSL + /* wgsl */ `
@group(0) @binding(1) var source: texture_2d<f32>;
fn loadSource(p: vec2i) -> vec3f {
  return textureLoad(source, clamp(p, vec2i(0), vec2i(params.inputSize) - vec2i(1)), 0).rgb;
}
fn bilinear(p: vec2f) -> vec3f {
  let base = vec2i(floor(p));
  let f = fract(p);
  return mix(mix(loadSource(base), loadSource(base + vec2i(1, 0)), f.x),
    mix(loadSource(base + vec2i(0, 1)), loadSource(base + vec2i(1, 1)), f.x), f.y);
}
`

export const BILINEAR_WGSL = LOAD_WGSL + /* wgsl */ `
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(bilinear(position.xy * params.inputSize / params.outputSize - vec2f(0.5)), 1.0);
}
`
