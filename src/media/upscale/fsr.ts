/**
 * Hand port of AMD FidelityFX FSR 1.0.2, RGB EASU + RCAS (0.2 stops, denoise on).
 * Reference mpv hook: agyild, FSR.glsl, revision f1794d720013ccd9c5c86a0f20fddd71e0375f94:
 * https://gist.github.com/agyild/82219c545228d70c5604f865ce0b0ce5
 * RGB reference: GPUOpen-Effects/FidelityFX-FSR, ffx-fsr/ffx_fsr1.h,
 * commit a21ffb8f6c13233ba336352bdff293894c706575:
 * https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/a21ffb8f6c13233ba336352bdff293894c706575/ffx-fsr/ffx_fsr1.h
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved. MIT license.
 * Full license: packaging/THIRD-PARTY-NOTICES.md.
 *
 * The caller supplies a clamped loadSource(vec2i) -> vec3f and params.inputSize /
 * params.outputSize. EASU positions are integer output pixel coordinates. Sampling
 * the crop into its own texture keeps every kernel tap inside the selected region.
 */

export const FSR_WGSL = /* wgsl */ `
fn fsrLuma(c: vec3f) -> f32 {
  return c.b * 0.5 + (c.r * 0.5 + c.g);
}

fn fsrLoRcp(a: f32) -> f32 {
  return bitcast<f32>(0x7ef07ebbu - bitcast<u32>(a));
}

fn fsrLoRsq(a: f32) -> f32 {
  return bitcast<f32>(0x5f347d74u - (bitcast<u32>(a) >> 1u));
}

fn fsrMedRcp(a: f32) -> f32 {
  let b = bitcast<f32>(0x7ef19fffu - bitcast<u32>(a));
  return b * (-b * a + 2.0);
}

// One of the four bilinearly weighted cross neighborhoods: direction.xy, length.z.
fn fsrEasuSet(w: f32, a: f32, b: f32, c: f32, d: f32, e: f32) -> vec3f {
  let dir = vec2f(d - b, e - a);
  let len = clamp(abs(dir) * vec2f(
    fsrLoRcp(max(abs(d - c), abs(c - b))),
    fsrLoRcp(max(abs(e - c), abs(c - a)))
  ), vec2f(0.0), vec2f(1.0));
  return vec3f(dir * w, dot(len, len) * w);
}

// The polynomial Lanczos2 window is the original EASU negative-lobe kernel.
fn fsrEasuTap(off: vec2f, dir: vec2f, len: vec2f, lob: f32, clp: f32, c: vec3f) -> vec4f {
  let v = vec2f(dot(off, dir), dot(off, vec2f(-dir.y, dir.x))) * len;
  let d2 = min(dot(v, v), clp);
  let base = 0.4 * d2 - 1.0;
  let window = lob * d2 - 1.0;
  let w = (1.5625 * base * base - 0.5625) * window * window;
  return vec4f(c * w, w);
}

fn easu(position: vec2f) -> vec3f {
  let sourcePosition = (position + vec2f(0.5)) * params.inputSize / params.outputSize - vec2f(0.5);
  let fp = vec2i(floor(sourcePosition));
  let pp = fract(sourcePosition);
  // Twelve taps in the same order as the mpv and AMD reference kernels.
  let b = loadSource(fp + vec2i(0, -1));
  let c = loadSource(fp + vec2i(1, -1));
  let i = loadSource(fp + vec2i(-1, 1));
  let j = loadSource(fp + vec2i(0, 1));
  let f = loadSource(fp);
  let e = loadSource(fp + vec2i(-1, 0));
  let k = loadSource(fp + vec2i(1, 1));
  let l = loadSource(fp + vec2i(2, 1));
  let h = loadSource(fp + vec2i(2, 0));
  let g = loadSource(fp + vec2i(1, 0));
  let o = loadSource(fp + vec2i(1, 2));
  let n = loadSource(fp + vec2i(0, 2));
  var analysis = fsrEasuSet((1.0 - pp.x) * (1.0 - pp.y), fsrLuma(b), fsrLuma(e), fsrLuma(f), fsrLuma(g), fsrLuma(j));
  analysis += fsrEasuSet(pp.x * (1.0 - pp.y), fsrLuma(c), fsrLuma(f), fsrLuma(g), fsrLuma(h), fsrLuma(k));
  analysis += fsrEasuSet((1.0 - pp.x) * pp.y, fsrLuma(f), fsrLuma(i), fsrLuma(j), fsrLuma(k), fsrLuma(n));
  analysis += fsrEasuSet(pp.x * pp.y, fsrLuma(g), fsrLuma(j), fsrLuma(k), fsrLuma(l), fsrLuma(o));
  var dir = analysis.xy;
  let dirSquared = dot(dir, dir);
  if (dirSquared < 1.0 / 32768.0) {
    dir = vec2f(1.0, 0.0);
  } else {
    dir *= fsrLoRsq(dirSquared);
  }
  let len = (analysis.z * 0.5) * (analysis.z * 0.5);
  let stretch = dot(dir, dir) * fsrLoRcp(max(abs(dir.x), abs(dir.y)));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + (0.21 - 0.5) * len;
  let clp = fsrLoRcp(lob);
  var sum = fsrEasuTap(vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  sum += fsrEasuTap(vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  sum += fsrEasuTap(vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  sum += fsrEasuTap(vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  sum += fsrEasuTap(-pp, dir, len2, lob, clp, f);
  sum += fsrEasuTap(vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  sum += fsrEasuTap(vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  sum += fsrEasuTap(vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  sum += fsrEasuTap(vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  sum += fsrEasuTap(vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  sum += fsrEasuTap(vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  sum += fsrEasuTap(vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  let minimum = min(min(f, g), min(j, k));
  let maximum = max(max(f, g), max(j, k));
  return clamp(sum.rgb / sum.a, minimum, maximum);
}

fn rcas(position: vec2i) -> vec3f {
  let b = loadSource(position + vec2i(0, -1));
  let d = loadSource(position + vec2i(-1, 0));
  let e = loadSource(position);
  let f = loadSource(position + vec2i(1, 0));
  let h = loadSource(position + vec2i(0, 1));
  let bL = fsrLuma(b);
  let dL = fsrLuma(d);
  let eL = fsrLuma(e);
  let fL = fsrLuma(f);
  let hL = fsrLuma(h);
  let maximumL = max(max(max(bL, dL), max(eL, fL)), hL);
  let minimumL = min(min(min(bL, dL), min(eL, fL)), hL);
  let noise = abs(0.25 * (bL + dL + fL + hL) - eL);
  let denoise = 1.0 - 0.5 * clamp(noise * fsrMedRcp(maximumL - minimumL), 0.0, 1.0);
  let minimum = min(min(b, d), min(f, h));
  let maximum = max(max(b, d), max(f, h));
  // Guard flat black/white neighborhoods against 0/0 without changing the limiters.
  let hitMin = min(minimum, e) / max(4.0 * maximum, vec3f(0.000001));
  let hitMax = (vec3f(1.0) - max(maximum, e)) / min(4.0 * minimum - vec3f(4.0), vec3f(-0.000001));
  let lobes = max(-hitMin, hitMax);
  let lobe = max(-0.1875, min(max(max(lobes.r, lobes.g), lobes.b), 0.0)) * exp2(-0.2) * denoise;
  return clamp((lobe * (b + d + h + f) + e) * fsrMedRcp(4.0 * lobe + 1.0), vec3f(0.0), vec3f(1.0));
}
`
