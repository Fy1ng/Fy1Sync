import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fingerprint, WIDTH, HEIGHT } from './fingerprint.mjs'

export function run(file, args, { limit = 32 * 1024 * 1024, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let bytes = 0
    let errorText = ''
    let failure = null
    const timer = setTimeout(() => { failure = new Error('experiment process timeout'); child.kill() }, timeout)
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > limit) { failure = new Error('experiment output limit exceeded'); child.kill(); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => { if (errorText.length < 8192) errorText += chunk.toString().slice(0, 8192 - errorText.length) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error(`${path.basename(file)} exit ${code}: ${errorText}`))
      else resolve(Buffer.concat(chunks))
    })
  })
}

// Decode only explicitly generated local fixtures. No remote media or profile access.
export async function decodeFixture(file, tools, { masks = [], crop } = {}) {
  const resolved = await realpath(file)
  const root = await realpath(tools.directory)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('fixture outside experiment directory')
  const metadata = JSON.parse((await run(tools.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file',
    '-select_streams', 'v:0', '-show_streams', '-show_frames',
    '-show_entries', 'stream=width,height,r_frame_rate,time_base:frame=pts_time,best_effort_timestamp_time',
    '-of', 'json', resolved])).toString())
  if (metadata.frames.length > 900) throw new Error('fixture too long')
  const pts = metadata.frames.map(f => Number(f.pts_time ?? f.best_effort_timestamp_time))
  if (pts.some(p => !Number.isFinite(p))) throw new Error('missing PTS')
  const filters = []
  if (crop) filters.push(`crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y}`)
  filters.push(`scale=${WIDTH}:${HEIGHT}:flags=area`, 'format=gray')
  const started = performance.now()
  const raw = await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2',
    '-copyts', '-protocol_whitelist', 'file', '-i', resolved, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', filters.join(','), '-fps_mode', 'passthrough', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
  const decodeMs = performance.now() - started
  const bytes = WIDTH * HEIGHT
  if (raw.length !== pts.length * bytes) throw new Error('ffprobe/rawvideo frame count mismatch')
  const featureStarted = performance.now()
  const frames = pts.map((pts, i) => ({ pts, fp: fingerprint(raw.subarray(i * bytes, (i + 1) * bytes), masks) }))
  return { frames, stream: metadata.streams[0], decodeMs, featureMs: performance.now() - featureStarted }
}

export async function generateFixtures(tools) {
  await mkdir(tools.directory, { recursive: true })
  const master = path.join(tools.directory, 'master.mp4')
  await run(tools.generator, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60:duration=6',
    '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-threads', '2', master])
  const output = async (name, filter, origin, crf) => {
    const file = path.join(tools.directory, `${name}.mp4`)
    await run(tools.generator, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', master,
      '-vf', filter, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-threads', '2',
      '-pix_fmt', 'yuv420p', '-output_ts_offset', String(origin), file])
    return file
  }
  // B starts one content second later, but uses an unrelated media timestamp origin.
  const a = await output('a-1080p60', 'scale=1920:1080', 10, 20)
  const b = await output('b-1440p30', 'trim=start=1:end=5,setpts=PTS-STARTPTS,fps=30,scale=2560:1440', 700, 29)
  const b25 = await output('b-1080p25', 'trim=start=1:end=5,setpts=PTS-STARTPTS,fps=25,scale=1920:1080', 700, 32)
  const ad = await output('b-ad-1440p30', 'trim=start=1:end=5,setpts=PTS-STARTPTS,fps=30,scale=2560:1440,drawbox=x=0:y=0:w=iw:h=ih/3:color=white:t=fill', 700, 29)
  const inset = await output('b-inset-1080p30', 'trim=start=1:end=5,setpts=PTS-STARTPTS,fps=30,scale=1536:864,pad=1920:1080:192:108:black', 700, 29)
  return { a, b, b25, ad, inset, expectedOffset: -689 }
}
