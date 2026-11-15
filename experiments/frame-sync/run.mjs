import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { decodeFixture, generateFixtures, run } from './media.mjs'
import { matchFrames, median, fitMapping, playbackResidual, coarseDistance, detailDistance } from './fingerprint.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const tools = {
  directory: path.join(repo, '.runtime-cache', 'frame-sync'),
  generator: process.env.FRAME_SYNC_GENERATOR ?? 'ffmpeg',
  ffmpeg: process.env.FRAME_SYNC_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.FRAME_SYNC_FFPROBE ?? 'ffprobe',
}
await mkdir(tools.directory, { recursive: true })
const versions = {}
for (const key of ['generator', 'ffmpeg', 'ffprobe']) versions[key] = (await run(tools[key], ['-version'])).toString().split(/\r?\n/)[0]
const fixtures = await generateFixtures(tools)
const a = await decodeFixture(fixtures.a, tools)
const b = await decodeFixture(fixtures.b, tools)
assert.equal(a.stream.width, 1920)
assert.equal(a.stream.height, 1080)
assert.equal(b.stream.width, 2560)
assert.equal(b.stream.height, 1440)
assert.equal(a.frames.length, 360)
assert.equal(b.frames.length, 120)
assert.ok(Math.abs(a.frames[0].pts - 10) < 0.001)
assert.ok(Math.abs(b.frames[0].pts - 700) < 0.001)

const results = []
function check(name, left, right, { expectMatch = true, tolerance = 1 / 30,
  expectedOffset = fixtures.expectedOffset, ...options } = {}) {
  const started = performance.now()
  const result = matchFrames(left, right, options)
  const matchMs = performance.now() - started
  if (expectMatch) {
    assert.equal(result.status, 'ok', `${name}: ${JSON.stringify(result)}`)
    assert.ok(Math.abs(result.offset - expectedOffset) <= tolerance,
      `${name}: offset ${result.offset} differs from ${expectedOffset}`)
  } else assert.equal(result.status, 'rejected', `${name}: false acceptance`)
  const errors = result.pairs?.map(p => Math.abs(p.a - p.b - expectedOffset)).sort((x, y) => x - y)
  if (errors) assert.ok(errors[Math.floor((errors.length - 1) * 0.95)] <= tolerance,
    `${name}: matched-frame P95 error exceeds ${tolerance}s`)
  results.push({ name, status: result.status, reason: result.reason,
    framesA: left.length, framesB: right.length, pairs: result.pairs?.length,
    offset: result.offset, medianErrorMs: errors ? median(errors) * 1000 : undefined,
    p95ErrorMs: errors ? errors[Math.floor((errors.length - 1) * 0.95)] * 1000 : undefined,
    confidence: result.confidence, temporalCorrelation: result.temporalCorrelation,
    frameQuantizationUncertaintyMs: result.uncertainty === undefined ? undefined : result.uncertainty * 1000,
    refined: result.refined, matchMs })
  return result
}
const baseline = check('1080p60-vs-1440p30-compressed', a.frames, b.frames)
check('swapped-source-direction', b.frames, a.frames, { expectedOffset: -fixtures.expectedOffset })
const b25 = await decodeFixture(fixtures.b25, tools)
assert.equal(b25.frames.length, 100)
check('60fps-vs-25fps', a.frames, b25.frames, { tolerance: 1 / 25 })
check('no-common-content-window', a.frames.filter(f => f.pts < 11), b.frames.filter(f => f.pts >= 703), { expectMatch: false })
check('lost-and-repeated-pictures', a.frames.filter((_, i) => i % 11 !== 0),
  b.frames.filter((_, i) => i % 9 !== 0).map((f, i, frames) => i % 13 === 0 && i > 0 ? { ...f, fp: frames[i - 1].fp } : f))
const mask = [{ x: 0, y: 0, width: 1, height: 1 / 3 }]
const maskedA = await decodeFixture(fixtures.a, tools, { masks: mask })
const ad = await decodeFixture(fixtures.ad, tools, { masks: mask })
check('masked-advertising-strip', maskedA.frames, ad.frames)
const inset = await decodeFixture(fixtures.inset, tools, { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } })
check('manual-common-content-registration', a.frames, inset.frames)

// Streaming-style repeated window measurements, without touching real playback.
const tracking = []
for (const start of [0, 0.5, 1, 1.5]) {
  const left = a.frames.filter(f => f.pts >= 11 + start && f.pts < 13 + start)
  const right = b.frames.filter(f => f.pts >= 700 + start && f.pts < 702 + start)
  const result = check(`tracking-window-${start}`, left, right)
  tracking.push(result.offset)
}
const mapping = fitMapping(baseline.pairs, { epoch: 'fixture-pair' })
const observation = { wallMs: 1000, rate: 1, playing: true, epoch: 'fixture-pair' }
const residual = playbackResidual(mapping, { ...observation, media: 14 }, { ...observation, media: 701 })
assert.ok(Math.abs(residual - 2) <= 1 / 30)

const comparisons = []
for (let i = 5; i < b.frames.length - 5; i++) {
  const target = b.frames[i]
  const expected = target.pts + fixtures.expectedOffset
  const neighbors = a.frames.filter(f => Math.abs(f.pts - expected) < 0.04)
  comparisons.push({ coarse: neighbors.map(f => coarseDistance(f.fp, target.fp)),
    fine: neighbors.map(f => detailDistance(f.fp, target.fp)),
    errors: neighbors.map(f => Math.abs(f.pts - expected)) })
}
const correct = kind => comparisons.filter(c => {
  const scores = c[kind]
  const best = scores.indexOf(Math.min(...scores))
  return c.errors[best] < 0.005
}).length
const report = {
  date: new Date().toISOString(), baselineCommit: '745c53b', scope: 'isolated-offline-feasibility',
  versions, platform: process.platform, arch: process.arch, node: process.version,
  expectedMappingOffset: fixtures.expectedOffset, results,
  extraction: Object.fromEntries(Object.entries({ a, b, b25, maskedA, ad, inset }).map(([name, data]) => [name, {
    stream: data.stream, frames: data.frames.length, decodeMs: data.decodeMs,
    featureMs: data.featureMs, featureMsPerFrame: data.featureMs / data.frames.length,
  }])),
  adjacentFrames: { samples: comparisons.length, coarseCorrect: correct('coarse'), detailCorrect: correct('fine'),
    note: 'Local nearest-frame probe only; no claim of universal frame uniqueness.' },
  trackingSpreadMs: (Math.max(...tracking) - Math.min(...tracking)) * 1000,
  playbackResidualSeconds: residual,
  memory: process.memoryUsage(),
  limitations: ['synthetic video only', 'software offline decode; not simultaneous live playback',
    'explicit ROI and mask; no automatic registration', 'no production integration or A/V output verification',
    'match confidence is a heuristic, not calibrated probability'],
}
const output = path.join(tools.directory, 'report.json')
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ report: output, results, adjacentFrames: report.adjacentFrames,
  trackingSpreadMs: report.trackingSpreadMs, playbackResidualSeconds: residual }, null, 2))
