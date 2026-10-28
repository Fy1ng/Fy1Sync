/**
 * Generate the local test sources under `public/test-sources/`.
 *
 * Automatic sync cannot be tested against a live Twitch stream: the countdown appears once,
 * at a time nobody controls, and the run would be unrepeatable. These fixtures are the
 * substitute — a synthetic scoreboard with a real countdown, rendered twice with a known
 * delay between them. The delay is the ground truth every sync assertion compares against,
 * so the sync design gates (detection error ≤ 0.25 s, post-apply divergence ≤ 0.35 s) become
 * checkable numbers rather than eyeballing.
 *
 * A full ffmpeg is required and is not a dependency of this project. Set
 * `STREAM_SYNC_FIXTURE_FFMPEG` to select it independently from the application.
 * Otherwise `STREAM_SYNC_FFMPEG` and then `ffmpeg` on PATH retain their precedence.
 *
 * Outputs are not committed: `public/test-sources/` is git-ignored, and the E2E suite skips
 * the media specs when they are absent.
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const outDir = fileURLToPath(new URL('../public/test-sources/', import.meta.url))
const ffmpeg = process.env.STREAM_SYNC_FIXTURE_FFMPEG?.trim() || process.env.STREAM_SYNC_FFMPEG?.trim() || 'ffmpeg'

/** The ROI the fixture profile expects, as fractions of the frame. Keep in sync with the JSON below. */
const ROI = { x: 0.42, y: 0.045, w: 0.16, h: 0.13 }
const WIDTH = 1280
const HEIGHT = 720
// Preserve enough stroke detail in 960-wide discovery frames for templates to
// recognise the later native-resolution ROI; a small font passed learning alone.
const FONT_SIZE = 88
const COUNTDOWN_FROM = 20
const DURATION = 26

/**
 * A drawtext expression counting down from `COUNTDOWN_FROM`, offset by `delay` seconds.
 *
 * `t` is the output timestamp, so a positive delay means this render reaches any given
 * countdown value later — exactly what a commentary stream running behind looks like. The
 * value is clamped at 0 so the clock holds at 0:00 instead of going negative.
 */
function countdownText(delay, countdownFrom = COUNTDOWN_FROM) {
  const elapsed = `(t-${delay})`
  const remaining = `max(0,${countdownFrom}-floor(${elapsed}))`
  // %{eif:...} formats an expression; :d:2 pads the seconds to two digits.
  return `0\\:%{eif\\:${remaining}\\:d\\:2}`
}

function fontPath() {
  if (process.env.STREAM_SYNC_FONT) return escapeForFilter(process.env.STREAM_SYNC_FONT)
  if (process.platform === 'win32') return escapeForFilter('C:/Windows/Fonts/consola.ttf')
  if (process.platform === 'darwin') return escapeForFilter('/System/Library/Fonts/Menlo.ttc')
  return escapeForFilter('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf')
}

/** A Windows drive colon would end the filter option, so it has to be escaped. */
function escapeForFilter(path) {
  return path.replace(/\\/gu, '/').replace(/:/gu, '\\:')
}

/**
 * The scoreboard: a dark plate behind the clock so binarization has clean separation, plus
 * a moving element so the frame is not static (a still image would let a decoder hold one
 * frame forever and hide timing bugs).
 */
function filterGraph(delay, label, countdownFrom = COUNTDOWN_FROM) {
  const plateX = Math.round(ROI.x * WIDTH)
  const plateY = Math.round(ROI.y * HEIGHT)
  const plateW = Math.round(ROI.w * WIDTH)
  const plateH = Math.round(ROI.h * HEIGHT)
  return [
    `drawbox=x=${plateX}:y=${plateY}:w=${plateW}:h=${plateH}:color=0x0B0E12@1:t=fill`,
    `drawtext=fontfile='${fontPath()}':text='${countdownText(delay, countdownFrom)}'` +
      `:fontsize=${FONT_SIZE}:fontcolor=0xF2F5F7` +
      `:x=${plateX}+(${plateW}-text_w)/2:y=${plateY}+(${plateH}-text_h)/2`,
    `drawtext=fontfile='${fontPath()}':text='${label}':fontsize=28:fontcolor=0x7A8798:x=32:y=32`,
    // A sweeping bar: visibly different every frame, well away from the ROI.
    `drawbox=x='mod(t*220\\,${WIDTH})':y=${HEIGHT - 60}:w=140:h=14:color=0x3D7EFF@0.9:t=fill`,
    ...(delay > 0 && label !== 'STILL' ? cameraFilters() : []),
  ].join(',')
}

/**
 * A streamer camera on the commentary source: a 16:9 box with a light border and moving
 * content at a fixed place, so the camera crop has a real rectangle to tighten onto. The
 * E2E spec checks the tightened crop against these numbers.
 */
export const CAMERA = { x: 64, y: 400, w: 256, h: 144, border: 3 }

function cameraFilters() {
  const { x, y, w, h, border } = CAMERA
  return [
    `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xE8EDF2@1:t=fill`,
    `drawbox=x=${x + border}:y=${y + border}:w=${w - border * 2}:h=${h - border * 2}:color=0x2A3340@1:t=fill`,
    // A "face" moving inside the frame, so the inside differs from frame to frame.
    `drawbox=x='${x + 40}+mod(t*37\\,${w - 120})':y=${y + 30}:w=60:h=70:color=0xC9946E@1:t=fill`,
  ]
}

function run(args) {
  return new Promise((resolve, reject) => {
    // Arguments are passed as an array, so no shell quoting is involved.
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) =>
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `找不到 ffmpeg (${ffmpeg}). 请安装完整版 ffmpeg 或设置 STREAM_SYNC_FIXTURE_FFMPEG.`
            : error.message,
        ),
      ),
    )
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 退出码 ${code}：\n${stderr.split('\n').slice(-12).join('\n')}`))
    })
  })
}

/** An MP4 with a countdown, `delay` seconds behind the reference render. */
async function renderVideo(name, delay, label, countdownFrom = COUNTDOWN_FROM, duration = DURATION) {
  const target = join(outDir, name)
  await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x141A21:s=${WIDTH}x${HEIGHT}:d=${duration}:r=30`,
    // A tone rather than silence: the commentary source is selected for audio, and a muted
    // track would not prove the audio path works.
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${delay > 0 ? 320 : 480}:duration=${duration}:sample_rate=48000`,
    '-vf',
    filterGraph(delay, label, countdownFrom),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    // Keyframe every 15 frames: seeking accuracy is what sync depends on, and a sparse
    // GOP would make every seek land up to two seconds off.
    '-g',
    '15',
    '-keyint_min',
    '15',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
    target,
  ])
  process.stdout.write(`  ${name}  countdown 0:${countdownFrom} → 0:00, 延迟 ${delay}s\n`)
}

/** A single frame, for the Profile Editor's template capture flow. */
async function renderStill(name, seconds) {
  const target = join(outDir, name)
  await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x141A21:s=${WIDTH}x${HEIGHT}:d=1:r=1`,
    '-vf',
    filterGraph(COUNTDOWN_FROM - seconds, 'STILL'),
    '-frames:v',
    '1',
    '-update',
    '1',
    target,
  ])
  process.stdout.write(`  ${name}  单帧 0:${String(seconds).padStart(2, '0')}\n`)
}

/**
 * An HLS rendition of the delayed source. A live stream is HLS, and the player's HLS path
 * (hls.js, level selection, seekable ranges) is different enough from progressive MP4 that
 * it needs its own fixture.
 */
async function renderHls(dirName, sourceName) {
  const dir = join(outDir, dirName)
  await mkdir(dir, { recursive: true })
  await run([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    join(outDir, sourceName),
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(dir, 'seg-%03d.ts'),
    join(dir, 'index.m3u8'),
  ])
  process.stdout.write(`  ${dirName}/index.m3u8  HLS VOD\n`)
}

/**
 * The profile that matches these fixtures, so a test run has something to recognise.
 *
 * Shape follows `RecognitionProfile` in src/core/profileSchema.ts — `preprocess.threshold` is
 * 0..255, not a fraction, and `templates` stays empty on purpose: glyphs come from a local
 * font, so bitmaps captured on one machine would not match another's render. Import this in
 * the Profile Editor and capture from `frame-0-20.png`.
 */
async function writeProfileStub() {
  const profile = {
    schemaVersion: 2,
    id: 'fixture/countdown',
    name: '测试源倒计时',
    roi: ROI,
    clockFormat: 'm:ss',
    detectWindowSeconds: 3,
    sampleFps: 30,
    matchThreshold: 0.82,
    // Light glyphs (0xF2F5F7) on a near-black plate (0x0B0E12): the bright pixels are
    // already the ink, so `invert` stays off — it is for the opposite polarity, a dark
    // clock on a light scoreboard. `binarize` keeps pixels >= threshold when invert is
    // false, and the plate sits far below 150 while the glyphs sit far above it.
    preprocess: { scale: 1.4, threshold: 150, invert: false },
    templates: {},
    updatedAt: 0,
    notes:
      '由 scripts/generate-test-sources.mjs 生成的测试源配套配置。模板需在 Profile Editor 中用 ' +
      'frame-0-20.png 采集：字形来自本机字体，不同机器渲染结果不同。',
  }
  const target = join(outDir, 'fixture-profile.json')
  await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  process.stdout.write('  fixture-profile.json  ROI 与预处理参数\n')
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  process.stdout.write('\n生成测试源…\n')
  // official is the reference; commentary trails it by 5 s, the delay every sync test asserts.
  await renderVideo('official.mp4', 0, 'OFFICIAL / clean feed')
  await renderVideo('commentary.mp4', 5, 'COMMENTARY / +5s')
  // Discovery and native ROI learning use separate live windows (12 seconds each).
  // Keep the editor's original 20-second lessons unchanged, with longer media for this flow.
  await renderVideo('auto-official.mp4', 0, 'OFFICIAL / native learning', 50, 56)
  await renderVideo('auto-commentary.mp4', 5, 'COMMENTARY / +5s', 50, 56)
  await renderStill('frame-0-20.png', 20)
  await renderStill('frame-0-05.png', 5)
  await renderHls('commentary-hls', 'commentary.mp4')
  await writeProfileStub()

  process.stdout.write(
    [
      '',
      `  输出目录 ${outDir}`,
      '  已知偏移 5.000s（commentary 落后 official）',
      '',
    ].join('\n'),
  )
}

main().catch((error) => {
  process.stderr.write(`\n生成失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
