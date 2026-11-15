import assert from 'node:assert/strict'
import { mkdir, writeFile, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { run, decodeFixture } from './media.mjs'
import { matchFrames, median } from './fingerprint.mjs'

const [inputA, inputB] = process.argv.slice(2)
if (!inputA || !inputB) throw new Error('Usage: node experiments/frame-sync/real-video.mjs <local-video-A> <local-video-B>')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const tools = {
  directory: path.join(repo, '.runtime-cache', 'frame-sync-real'),
  ffmpeg: process.env.FRAME_SYNC_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.FRAME_SYNC_FFPROBE ?? 'ffprobe',
}
await mkdir(tools.directory, { recursive: true })
const inputs = [await realpath(inputA), await realpath(inputB)]
const sourceInfo = []
for (const file of inputs) {
  const info = await stat(file)
  assert.ok(info.isFile())
  const metadata = JSON.parse((await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file',
    '-show_entries', 'format=start_time,duration:stream=index,codec_name,codec_type,width,height,r_frame_rate,time_base,start_time', '-of', 'json', file])).toString())
  sourceInfo.push({ name: path.basename(file), bytes: info.size, modified: info.mtime.toISOString(), metadata })
}
const versions = {}
for (const key of ['ffmpeg', 'ffprobe']) versions[key] = (await run(tools[key], ['-version'])).toString().split(/\r?\n/)[0]
const duration = Math.min(...sourceInfo.map(s => Number(s.metadata.format.duration)))
const starts = process.env.FRAME_SYNC_STARTS ? process.env.FRAME_SYNC_STARTS.split(',').map(Number)
  : [0, 30, 120, 300, 600, 900, 1200, 1500, 1800, 2100, 2700, 3075]
assert.ok(starts.length <= 24 && starts.every(s => Number.isFinite(s) && s >= 0 && s + 6 < duration))
const rows = []
const reportFile = path.join(tools.directory, process.env.FRAME_SYNC_STARTS
  ? `real-report-${starts.join('-')}.json` : 'real-report.json')
const report = { date: new Date().toISOString(), sources: sourceInfo, versions,
  configuration: { sampleSeconds: 6, starts, fingerprint: '128x72, unchanged POC defaults',
    notes: 'Streamcopy clips retain source PTS and can contain keyframe preroll. Only requested media-time intervals are matched.' },
  results: rows, limitations: ['sampled windows only', 'offline decode, no Electron playback',
    'no independent frame labels; high-resolution validation is a cross-check, not exact ground truth'] }

async function clip(source, role, start) {
  const file = path.join(tools.directory, `${role}-${start}.mp4`)
  // -to is absolute with copyts. An output -t 6 would end before PTS 120, etc.
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-copyts', '-ss', String(start), '-protocol_whitelist', 'file', '-i', source,
    '-to', String(start + 6), '-map', '0:v:0', '-an', '-sn', '-dn', '-c', 'copy',
    '-frames:v', '900', '-avoid_negative_ts', 'disabled', file])
  const decoded = await decodeFixture(file, tools)
  return { ...decoded, file, selected: decoded.frames.filter(f => f.pts >= start && f.pts < start + 6) }
}

async function highResolutionCheck(left, right, pairs) {
  const width = 320
  const height = 180
  const bytes = width * height
  const decode = async data => {
    const raw = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2',
      '-copyts', '-protocol_whitelist', 'file', '-i', data.file, '-map', '0:v:0', '-an',
      '-vf', `scale=${width}:${height}:flags=area,format=gray`, '-fps_mode', 'passthrough',
      '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { limit: 64 * 1024 * 1024 })
    assert.equal(raw.length, data.frames.length * bytes)
    return raw
  }
  const rawA = await decode(left)
  const rawB = await decode(right)
  const mean = (raw, frame) => {
    let sum = 0
    for (let i = frame * bytes; i < (frame + 1) * bytes; i++) sum += raw[i]
    return sum / bytes
  }
  const meansA = left.frames.map((_, i) => mean(rawA, i))
  const meansB = right.frames.map((_, i) => mean(rawB, i))
  const checks = []
  for (const fraction of [0.1, 0.35, 0.6, 0.85]) {
    const p = pairs[Math.floor((pairs.length - 1) * fraction)]
    const j = right.frames.findIndex(f => f.pts === p.b)
    let best = null
    for (let i = 0; i < left.frames.length; i++) {
      if (!left.selected.includes(left.frames[i])) continue
      const brightness = meansA[i] - meansB[j]
      let sum = 0
      for (let pixel = 0; pixel < bytes; pixel++) sum += Math.abs(rawA[i * bytes + pixel] - rawB[j * bytes + pixel] - brightness)
      const error = sum / bytes / 255
      if (!best || error < best.error) best = { a: left.frames[i].pts, error }
    }
    checks.push({ matchedA: p.a, b: p.b, independentA: best.a,
      disagreementMs: Math.abs(p.a - best.a) * 1000, normalizedPixelError: best.error })
  }
  return checks
}

function temporalDiagnostics(left, right, pairs) {
  const values = []
  for (const step of [1, 2, 3, 6]) {
    const correlations = []
    for (let i = step; i < pairs.length; i++) {
      const ap = left.find(f => f.pts === pairs[i - step].a).fp.detail
      const ac = left.find(f => f.pts === pairs[i].a).fp.detail
      const bp = right.find(f => f.pts === pairs[i - step].b).fp.detail
      const bc = right.find(f => f.pts === pairs[i].b).fp.detail
      let dot = 0
      let ea = 0
      let eb = 0
      for (let p = 0; p < ap.length; p++) {
        const da = ac[p] - ap[p]
        const db = bc[p] - bp[p]
        dot += da * db
        ea += da * da
        eb += db * db
      }
      correlations.push(ea && eb ? dot / Math.sqrt(ea * eb) : 0)
    }
    values.push({ matchedFrameStep: step, correlation: median(correlations) })
  }
  return values
}

for (const start of starts) {
  const began = performance.now()
  const left = await clip(inputs[0], 'a', start)
  const right = await clip(inputs[1], 'b', start)
  const matchingAt = performance.now()
  const result = matchFrames(left.selected, right.selected)
  const matchMs = performance.now() - matchingAt
  const row = { start, status: result.status, reason: result.reason,
    framesA: left.selected.length, framesB: right.selected.length, pairs: result.pairs?.length,
    offset: result.offset, residualMs: result.residual === undefined ? undefined : result.residual * 1000,
    temporalCorrelation: result.temporalCorrelation, confidence: result.confidence,
    frameQuantizationUncertaintyMs: result.uncertainty === undefined ? undefined : result.uncertainty * 1000,
    matchMs, decodeMs: { a: left.decodeMs, b: right.decodeMs },
    featureMs: { a: left.featureMs, b: right.featureMs },
    pairExamples: result.pairs?.filter((_, i) => i % Math.max(1, Math.floor(result.pairs.length / 5)) === 0) }
  if (result.status === 'ok' && [120, 1500, 2700].includes(start)) {
    row.highResolutionChecks = await highResolutionCheck(left, right, result.pairs)
  }
  if (result.reason === 'inconsistent-motion') {
    // This bypass only exposes a rejected hypothesis for independent diagnosis.
    // It never changes the acceptance result or claims fresh sync evidence.
    const candidate = matchFrames(left.selected, right.selected, { minTemporalCorrelation: 0 })
    if (candidate.status === 'ok') row.rejectedHypothesis = {
      offset: candidate.offset, pairExamples: candidate.pairs.filter((_, i) => i % 60 === 0),
      temporalDiagnostics: temporalDiagnostics(left.selected, right.selected, candidate.pairs),
      highResolutionChecks: await highResolutionCheck(left, right, candidate.pairs),
    }
  }
  if (start === 1500 && result.status === 'ok') {
    const variants = [
      ['downsample-A-to-30fps', left.selected.filter((_, i) => i % 2 === 0), right.selected],
      ['drops-and-duplicate-pictures', left.selected.filter((_, i) => i % 11 !== 0),
        right.selected.filter((_, i) => i % 9 !== 0).map((f, i, frames) => i > 0 && i % 13 === 0 ? { ...f, fp: frames[i - 1].fp } : f)],
      ['nonoverlapping-real-content', left.selected.filter(f => f.pts < start + 2), right.selected.filter(f => f.pts >= start + 4)],
    ]
    row.perturbations = variants.map(([name, a, b]) => {
      const measured = matchFrames(a, b)
      return { name, status: measured.status, reason: measured.reason,
        offset: measured.offset, offsetDifferenceMs: measured.offset === undefined ? undefined : Math.abs(measured.offset - result.offset) * 1000,
        temporalCorrelation: measured.temporalCorrelation }
    })
  }
  row.elapsedMs = performance.now() - began
  rows.push(row)
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(row))
}
const accepted = rows.filter(r => r.status === 'ok')
report.summary = { accepted: accepted.length, rejected: rows.length - accepted.length,
  offsetMedian: accepted.length ? median(accepted.map(r => r.offset)) : null,
  offsetMin: accepted.length ? Math.min(...accepted.map(r => r.offset)) : null,
  offsetMax: accepted.length ? Math.max(...accepted.map(r => r.offset)) : null,
  medianMatchMs: median(rows.map(r => r.matchMs)),
  highResolutionChecks: accepted.flatMap(r => r.highResolutionChecks ?? []) }
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ report: reportFile, summary: report.summary }))
