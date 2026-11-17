import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprint, matchFrames, fitMapping, playbackResidual, FingerprintWindow, WIDTH, HEIGHT } from './fingerprint.mjs'

function image(index, { stationary = false, periodic = false, unrelated = false, subtle = false, ad = false } = {}) {
  const gray = new Uint8Array(WIDTH * HEIGHT)
  const t = stationary ? 0 : periodic ? index % 15 : index
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const base = 95 + 28 * Math.sin(x / 8) + 23 * Math.cos(y / 7)
    const motion = subtle ? 4 * Math.sin(x / 3 + t * 0.18) * Math.sin(y / 4 + t * 0.13)
      : 43 * Math.sin((x + t * 2.3) / 9) * Math.cos((y - t * 1.7) / 7)
    const value = unrelated ? 110 + 55 * Math.sin(x / 2 + t / 2) * Math.cos(y / 2 + t / 3) : base + motion
    gray[y * WIDTH + x] = Math.round(ad && y < HEIGHT / 3 ? (index % 2 ? 250 : 5) : value)
  }
  return gray
}

const sequence = (indices, origin = 0, options = {}) => indices.map(i => ({ pts: origin + i / 30, fp: fingerprint(image(i, options), options.masks) }))
const indices = n => Array.from({ length: n }, (_, i) => i)

test('independent timestamp origins do not change the matched content', () => {
  const result = matchFrames(sequence(indices(120), 9), sequence(indices(75).map(i => i + 24), 500))
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs(result.offset + 491) < 0.01)
  assert.ok(result.pairs.length >= 65)
})

test('dropped frames, duplicate pictures and unequal sampling preserve mapping', () => {
  const a = sequence(indices(150))
  const b = sequence(indices(150).filter(i => i % 2 === 0 && i % 14 !== 0), 120)
  for (let i = 8; i < b.length; i += 13) b[i].fp = b[i - 1].fp
  const result = matchFrames(a, b)
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs(result.offset + 120) <= 1 / 30)
})

test('mask excludes a changing advertising strip', () => {
  const masks = [{ x: 0, y: 0, width: 1, height: 1 / 3 }]
  const result = matchFrames(sequence(indices(90), 0, { masks }), sequence(indices(90), 40, { masks, ad: true }))
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs(result.offset + 40) < 0.001)
})

test('subtle changes can support a sequence without a visible frame counter', () => {
  const result = matchFrames(sequence(indices(100), 0, { subtle: true }), sequence(indices(75).map(i => i + 12), 25, { subtle: true }), { minMotion: 0.0005 })
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs(result.offset + 25) <= 1 / 30)
})

test('static textured pictures must not produce new alignment evidence', () => {
  const result = matchFrames(sequence(indices(90), 0, { stationary: true }), sequence(indices(90), 20, { stationary: true }))
  assert.equal(result.status, 'rejected')
  assert.ok(['static-sequence', 'ambiguous-sequence'].includes(result.reason))
})

test('independent low amplitude noise on a static picture is not new evidence', () => {
  const noisy = origin => indices(90).map(i => {
    const gray = image(0, { stationary: true })
    let random = origin * 1000 + i + 1
    for (let p = 0; p < gray.length; p++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      gray[p] += (random % 5) - 2
    }
    return { pts: origin + i / 30, fp: fingerprint(gray) }
  })
  assert.equal(matchFrames(noisy(0), noisy(20)).status, 'rejected')
})

test('repeated animation must not manufacture a unique offset', () => {
  const result = matchFrames(sequence(indices(150), 0, { periodic: true }), sequence(indices(150), 20, { periodic: true }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'ambiguous-sequence')
})

test('unrelated video is rejected', () => {
  const result = matchFrames(sequence(indices(90)), sequence(indices(90), 20, { unrelated: true }))
  assert.equal(result.status, 'rejected')
})

test('timestamp reset requires a new continuity window', () => {
  const frames = sequence(indices(60))
  frames[30].pts = 0
  assert.throws(() => matchFrames(frames, sequence(indices(60))), /discontinuity/)
})

test('long baseline robustly estimates drift with one bad correspondence', () => {
  const pairs = indices(100).map(i => ({ b: 500 + i, a: 7 + i * 1.0002 }))
  pairs[15].a += 4
  const mapping = fitMapping(pairs)
  assert.equal(mapping.driftEstimated, true)
  assert.ok(Math.abs(mapping.slope - 1.0002) < 1e-8)
  assert.ok(mapping.mad < 1e-8)
})

test('short windows do not claim measurable clock drift', () => {
  assert.equal(fitMapping(indices(20).map(i => ({ a: i / 30, b: 100 + i / 30 }))).driftEstimated, false)
})

test('playback residual uses mapping and a shared observation clock', () => {
  const mapping = fitMapping(indices(30).map(i => ({ a: 10 + i, b: 700 + i })), { epoch: 'pair-1' })
  const observation = { wallMs: 1000, rate: 1, playing: true, epoch: 'pair-1' }
  assert.equal(playbackResidual(mapping, { ...observation, media: 15 }, { ...observation, media: 703 }), 2)
  assert.ok(Math.abs(playbackResidual(mapping, { ...observation, media: 15, wallMs: 1020 }, { ...observation, media: 704.98 })) < 1e-10)
})

test('stalled and stale observations cannot drive a correction', () => {
  const mapping = { originA: 0, originB: 0, slope: 1, epoch: 'pair-1' }
  const observation = { media: 0, wallMs: 0, rate: 1, playing: true, epoch: 'pair-1' }
  assert.throws(() => playbackResidual(mapping, observation, { ...observation, playing: false }), /stalled/)
  assert.throws(() => playbackResidual(mapping, observation, { ...observation, epoch: 'pair-2' }), /stale/)
  assert.throws(() => playbackResidual(mapping, { ...observation, epoch: 'pair-2' }, { ...observation, epoch: 'pair-2' }), /stale/)
  assert.throws(() => playbackResidual(mapping, observation, { ...observation, wallMs: 150 }), /far apart/)
})

test('fingerprint retention is bounded and resets after reconnect or rewind', () => {
  const window = new FingerprintWindow(1, 12)
  for (const frame of sequence(indices(100))) window.push(frame, 'first')
  assert.equal(window.frames.length, 12)
  window.push(sequence([110])[0], 'second')
  assert.equal(window.frames.length, 1)
  window.push(sequence([0])[0], 'second')
  assert.equal(window.frames.length, 1)
})

test('fully masked and oversized inputs are refused', () => {
  assert.throws(() => fingerprint(image(0), [{ x: 0, y: 0, width: 1, height: 1 }]), /visible/)
  assert.throws(() => matchFrames(Array(901).fill({ pts: 0 }), []), /900/)
})

test('retention also enforces media duration when frame count is small', () => {
  const window = new FingerprintWindow(1, 900)
  for (const frame of sequence(indices(80))) window.push(frame, 'same')
  assert.ok(window.frames.at(-1).pts - window.frames[0].pts <= 1)
  assert.ok(window.frames.length < 40)
})
