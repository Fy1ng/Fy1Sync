// Pure signature matching, shared in behavior with the isolated feasibility experiment.
export const WIDTH = 128
export const HEIGHT = 72
const GRID_X = 4
const GRID_Y = 3
const COS = Array.from({ length: 4 }, (_, k) =>
  Array.from({ length: 8 }, (_, x) => Math.cos(Math.PI * (2 * x + 1) * k / 16)))

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function fingerprint(gray, masks = []) {
  if (gray.length !== WIDTH * HEIGHT) throw new Error('invalid normalized frame size')
  const detail = new Float32Array(WIDTH * HEIGHT / 4)
  const valid = new Uint8Array(detail.length)
  const hashes = []
  let mean = 0
  let count = 0
  const visible = (x, y) => !masks.some(r => x >= r.x * WIDTH && y >= r.y * HEIGHT
    && x < (r.x + r.width) * WIDTH && y < (r.y + r.height) * HEIGHT)
  for (let y = 0; y < HEIGHT; y += 2) for (let x = 0; x < WIDTH; x += 2) {
    const i = y / 2 * WIDTH / 2 + x / 2
    if (!visible(x, y)) continue
    valid[i] = 1
    detail[i] = gray[y * WIDTH + x]
    mean += detail[i]
    count++
  }
  if (count < detail.length / 4) throw new Error('insufficient visible area')
  mean /= count
  for (let i = 0; i < detail.length; i++) if (valid[i]) detail[i] -= mean
  for (let by = 0; by < GRID_Y; by++) for (let bx = 0; bx < GRID_X; bx++) {
    const tile = new Float64Array(64)
    let visibleCount = 0
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let sum = 0
      // Each 32x24 block is reduced to 8x8 with box averaging.
      for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 4; xx++) {
        const sx = bx * 32 + x * 4 + xx
        const sy = by * 24 + y * 3 + yy
        if (visible(sx, sy)) { sum += gray[sy * WIDTH + sx]; visibleCount++ }
        else sum += 128
      }
      tile[y * 8 + x] = sum / 12
    }
    if (visibleCount < 32 * 24 * 0.9) { hashes.push(null); continue }
    const coefficients = []
    for (let v = 0; v < 4; v++) for (let u = 0; u < 4; u++) {
      if (u === 0 && v === 0) continue
      let sum = 0
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) sum += tile[y * 8 + x] * COS[u][x] * COS[v][y]
      coefficients.push(sum)
    }
    const threshold = median(coefficients)
    hashes.push(coefficients.reduce((bits, c, i) => bits | (c > threshold ? 1 << i : 0), 0))
  }
  return { hashes, detail, valid }
}

function popcount(bits) {
  let count = 0
  while (bits) { bits &= bits - 1; count++ }
  return count
}

export function coarseDistance(a, b) {
  let sum = 0
  let count = 0
  for (let i = 0; i < a.hashes.length; i++) {
    if (a.hashes[i] === null || b.hashes[i] === null) continue
    sum += popcount(a.hashes[i] ^ b.hashes[i])
    count += 15
  }
  return count ? sum / count : Infinity
}

export function detailDistance(a, b) {
  let sum = 0
  let count = 0
  for (let i = 0; i < a.detail.length; i++) if (a.valid[i] && b.valid[i]) {
    sum += Math.abs(a.detail[i] - b.detail[i])
    count++
  }
  return count ? sum / count / 255 : Infinity
}

function validateFrames(frames) {
  if (frames.length > 900) throw new Error('experiment window exceeds 900 frames')
  for (let i = 0; i < frames.length; i++) {
    if (!Number.isFinite(frames[i].pts) || (i && frames[i].pts <= frames[i - 1].pts)) {
      throw new Error('timestamp discontinuity: split the generation before matching')
    }
  }
}

export function matchFrames(a, b, options = {}) {
  validateFrames(a)
  validateFrames(b)
  if (a.length < 8 || b.length < 8) return { status: 'rejected', reason: 'short-window' }
  const minSpan = options.minSpan ?? 0.8
  const stepTolerance = options.stepTolerance ?? 0.065
  const candidates = []
  const buckets = new Map()
  let refined = 0
  // Offset hypotheses make the subsequent monotone alignment a narrow search.
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const coarse = coarseDistance(a[i].fp, b[j].fp)
    if (coarse > (options.maxCoarse ?? 0.28)) continue
    refined++
    const detail = detailDistance(a[i].fp, b[j].fp)
    if (detail > (options.maxDetail ?? 0.055)) continue
    const candidate = { i, j, offset: a[i].pts - b[j].pts, cost: detail + coarse * 0.03 }
    candidates.push(candidate)
    const bucket = Math.round(candidate.offset / stepTolerance)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + Math.max(0, 1 - candidate.cost / 0.065))
  }
  if (!candidates.length) return { status: 'rejected', reason: 'no-candidates', refined }
  const hypotheses = [...buckets].sort((x, y) => y[1] - x[1]).slice(0, 12)
  const solutions = []
  for (const [bucket] of hypotheses) {
    const center = bucket * stepTolerance
    const local = candidates.filter(c => Math.abs(c.offset - center) <= stepTolerance)
      .sort((x, y) => x.i - y.i || x.j - y.j)
    let best = null
    // Bounded local dynamic programming. Skips allow unequal FPS and lost frames.
    for (let k = 0; k < local.length; k++) {
      const current = local[k]
      current.score = 1 - current.cost / 0.065
      current.previous = null
      for (let p = k - 1; p >= 0; p--) {
        const previous = local[p]
        if (a[current.i].pts - a[previous.i].pts > 0.5) break
        if (previous.i >= current.i || previous.j >= current.j) continue
        if (Math.abs(current.offset - previous.offset) > stepTolerance) continue
        const score = previous.score + 1 - current.cost / 0.065
        if (score > current.score) { current.score = score; current.previous = previous }
      }
      if (!best || current.score > best.score) best = current
    }
    if (!best) continue
    const pairs = []
    for (let p = best; p; p = p.previous) pairs.push(p)
    pairs.reverse()
    const span = a[pairs.at(-1).i].pts - a[pairs[0].i].pts
    if (pairs.length < 8 || span < minSpan) continue
    solutions.push({ pairs, span, score: best.score, offset: median(pairs.map(p => p.offset)) })
  }
  solutions.sort((x, y) => y.score - x.score)
  const best = solutions[0]
  if (!best) return { status: 'rejected', reason: 'insufficient-sequence', refined }
  const ambiguous = solutions.some(s => Math.abs(s.offset - best.offset) > stepTolerance * 2.5
    && s.pairs.length >= best.pairs.length * 0.75
    && (s.score >= best.score * 0.92 || s.score / s.pairs.length >= best.score / best.pairs.length * 0.98))
  if (ambiguous) {
    return { status: 'rejected', reason: 'ambiguous-sequence', refined }
  }
  const selected = best.pairs.map(p => ({ a: a[p.i].pts, b: b[p.j].pts, cost: p.cost }))
  const changes = selected.slice(1).map((_, i) => detailDistance(a[best.pairs[i].i].fp, a[best.pairs[i + 1].i].fp))
  if (median(changes) < (options.minMotion ?? 0.001)) {
    return { status: 'rejected', reason: 'static-sequence', refined }
  }
  // Similar static backgrounds can dominate pHash and pixel error. Verify that
  // the *changing* pixels agree across time, rather than just the backgrounds.
  const correlations = []
  const temporalStep = Math.max(1, Math.min(6, options.temporalStep ?? 1))
  for (let i = temporalStep; i < best.pairs.length; i++) {
    const previous = best.pairs[i - temporalStep]
    const current = best.pairs[i]
    const ap = a[previous.i].fp
    const ac = a[current.i].fp
    const bp = b[previous.j].fp
    const bc = b[current.j].fp
    let dot = 0
    let energyA = 0
    let energyB = 0
    for (let p = 0; p < ac.detail.length; p++) {
      if (!ap.valid[p] || !ac.valid[p] || !bp.valid[p] || !bc.valid[p]) continue
      const da = ac.detail[p] - ap.detail[p]
      const db = bc.detail[p] - bp.detail[p]
      dot += da * db
      energyA += da * da
      energyB += db * db
    }
    correlations.push(energyA && energyB ? dot / Math.sqrt(energyA * energyB) : 0)
  }
  const temporalCorrelation = median(correlations)
  if (temporalCorrelation < (options.minTemporalCorrelation ?? 0.85)) {
    return { status: 'rejected', reason: 'inconsistent-motion', refined, temporalCorrelation }
  }
  const offset = median(selected.map(p => p.a - p.b))
  const residual = median(selected.map(p => Math.abs(p.a - p.b - offset)))
  const frameInterval = frames => median(frames.slice(1).map((f, i) => f.pts - frames[i].pts))
  const uncertainty = Math.max(frameInterval(a), frameInterval(b)) / 2 + residual
  return { status: 'ok', offset, residual, span: best.span, pairs: selected, refined,
    temporalCorrelation, uncertainty,
    confidence: Math.min(1, selected.length / 20) * Math.max(0, 1 - residual / stepTolerance) * temporalCorrelation }
}

// A_media = slope * B_media + intercept. Never interpret intercept as live delay.
export function fitMapping(pairs, { epoch } = {}) {
  if (pairs.length < 8) throw new Error('insufficient mapping evidence')
  const centerB = median(pairs.map(p => p.b))
  const centerA = median(pairs.map(p => p.a))
  const slopes = []
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const span = pairs[j].b - pairs[i].b
    if (span >= 10) slopes.push((pairs[j].a - pairs[i].a) / span)
  }
  const slope = slopes.length ? median(slopes) : 1
  const intercept = median(pairs.map(p => p.a - slope * (p.b - centerB)))
  const mad = median(pairs.map(p => Math.abs(p.a - (intercept + slope * (p.b - centerB)))))
  return { slope, originB: centerB, originA: intercept, centerA, mad, driftEstimated: slopes.length > 0, epoch }
}

export function playbackResidual(mapping, a, b) {
  // Epoch identifies the pair's source generations plus discontinuity revisions.
  if (!a.playing || !b.playing || mapping.epoch === undefined
    || mapping.epoch !== a.epoch || mapping.epoch !== b.epoch) throw new Error('stale or stalled playback observation')
  const wall = Math.max(a.wallMs, b.wallMs)
  if (Math.abs(a.wallMs - b.wallMs) > 100) throw new Error('observations too far apart')
  const currentA = a.media + (wall - a.wallMs) / 1000 * a.rate
  const currentB = b.media + (wall - b.wallMs) / 1000 * b.rate
  // Positive means A is ahead, matching the existing official/commentary convention.
  return currentA - (mapping.originA + mapping.slope * (currentB - mapping.originB))
}

export class FingerprintWindow {
  constructor(seconds = 60, maxFrames = 900) { this.seconds = seconds; this.maxFrames = maxFrames; this.frames = []; this.generation = null }
  push(frame, generation) {
    if (generation !== this.generation || (this.frames.length && frame.pts <= this.frames.at(-1).pts)) this.frames = []
    this.generation = generation
    this.frames.push(frame)
    while (this.frames.length > this.maxFrames || frame.pts - this.frames[0].pts > this.seconds) this.frames.shift()
  }
}
