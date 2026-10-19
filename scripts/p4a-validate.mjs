// Offline real-recording measurements. All generated data stays in the ignored cache.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = join(root, '.runtime-cache/p4a-fix')
await mkdir(cache, { recursive: true })
const ffmpeg = process.env.STREAM_SYNC_FFMPEG ?? '<home>\\Desktop\\ffmpeg\\bin\\ffmpeg.exe'
const cli = process.env.STREAM_SYNC_CLI ?? join(root, 'target/release/stream-syncer-cli' + (process.platform === 'win32' ? '.exe' : ''))
const pairs = [
  { id: 'A', directory: '2026-10-18T20-19-14-448Z', official: 'official-youtube.ts', duration: 480 },
  { id: 'B', directory: '2026-10-18T21-02-39Z-max', official: 'official-youtube-1440.mkv', duration: 310 },
]
const input = (pair, source) => join(root, 'prototype/.media', pair.directory, source === 'official' ? pair.official : 'commentary-douyu.ts')

async function run(command, args, output) {
  const destination = createWriteStream(output)
  const started = performance.now()
  const child = spawn(command, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(destination)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536) })
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes) })
  await new Promise((yes, no) => { destination.once('error', no); if (destination.writableFinished) yes(); else destination.once('finish', yes) })
  if (stderr) await writeFile(output + '.stderr.log', stderr)
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`)
  console.log(`${output.slice(cache.length + 1)}: ${((performance.now() - started) / 1000).toFixed(2)}s`)
}

const stage = process.argv[2] ?? 'all'
if (stage === 'all' || stage === 'offset') {
  for (const pair of pairs) {
    await run(cli, ['offset', '--auto', '--official', input(pair, 'official'), '--commentary', input(pair, 'commentary'),
      '--from', '0', '--ffmpeg', ffmpeg], join(cache, `${pair.id}-auto.jsonl`))
  }
}
if (stage === 'all' || stage === 'locate') {
  for (const pair of pairs) for (const source of ['official', 'commentary']) {
    const pictures = []
    for (let from = 0; from + 8 <= pair.duration; from += 60) {
      const name = `${pair.id}-${source}-${from}`
      await run(cli, ['locate', '--video', input(pair, source), '--from', String(from), '--duration', '8', '--ffmpeg', ffmpeg], join(cache, `${name}-locate.jsonl`))
      const picture = join(cache, `${name}.png`)
      const target = from + 4
      const seek = Math.max(0, target - 10)
      await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', String(seek), '-i', input(pair, source), '-ss', String(target - seek),
        '-frames:v', '1', '-vf', 'scale=480:270', '-y', picture], join(cache, `${name}-snapshot.log`))
      pictures.push(picture)
    }
    const columns = 4
    const layout = pictures.map((_, i) => `${i % columns * 480}_${Math.floor(i / columns) * 270}`).join('|')
    await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...pictures.flatMap((p) => ['-i', p]),
      '-filter_complex', `xstack=inputs=${pictures.length}:layout=${layout}:fill=black`, '-frames:v', '1', '-y', join(cache, `${pair.id}-${source}-contact.png`)],
    join(cache, `${pair.id}-${source}-contact.log`))
  }
}
if (stage === 'all' || stage === 'summarize') {
  const result = []
  for (const pair of pairs) {
    const rows = (await readFile(join(cache, `${pair.id}-auto.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    const candidateProfileFiles = []
    for (const row of rows.filter((r) => r.type === 'learning' && r.accepted && r.report?.profile)) {
      const content = JSON.stringify(row.report.profile, null, 2) + '\n'
      const digest = createHash('sha256').update(content).digest('hex').slice(0, 12)
      const filename = `${pair.id}-${row.source}-candidate-${digest}.json`
      try { await writeFile(join(cache, filename), content, { flag: 'wx' }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      candidateProfileFiles.push(filename)
    }
    const locateWindows = []
    for (const source of ['official', 'commentary']) for (let from = 0; from + 8 <= pair.duration; from += 60) {
      try {
        const row = JSON.parse(await readFile(join(cache, `${pair.id}-${source}-${from}-locate.jsonl`), 'utf8'))
        locateWindows.push({ source, from, candidates: row.candidates, processingSeconds: row.processingSeconds })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const groundTruth = pair.id === 'A' ? 37.867 : -9.911
    const offset = rows.find((r) => r.type === 'offset')
    result.push({ recording: pair.id, groundTruth,
      medianErrorMs: offset?.estimate?.median == null ? null : (offset.estimate.median - groundTruth) * 1000,
      containers: rows.filter((r) => r.type === 'container'),
      learningWindows: rows.filter((r) => r.type === 'learning-window' || r.type === 'training'),
      localization: rows.filter((r) => r.type === 'localization'), learning: rows.filter((r) => r.type === 'learning').map((r) => ({ ...r, report: r.report && { ...r.report, profile: r.report.profile ? { ...r.report.profile, templates: Object.keys(r.report.profile.templates) } : null } })),
      summary: rows.filter((r) => r.type === 'summary'), offset, locateWindows, candidateProfileFiles })
  }
  await writeFile(join(cache, 'measurements.json'), JSON.stringify(result, null, 2))
  await writeFile(join(cache, 'measurement-provenance.json'), JSON.stringify({
    cliPath: resolve(cli),
    cliSha256: createHash('sha256').update(await readFile(cli)).digest('hex'),
    regeneratedAt: new Date().toISOString(),
    note: 'Ground truth supplied independently: A +37.867s, B -9.911s. Contact images inspect only the middle of each 8s window. Wall-clock/recorder alignment is not inferred.',
  }, null, 2))
  console.log(resolve(cache, 'measurements.json'))
}
