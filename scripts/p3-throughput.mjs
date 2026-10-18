// Untuned throughput control, not an accuracy or offset benchmark for this broadcast.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, '.runtime-cache', 'p3-throughput')
const values = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!['--ffmpeg', '--cli', '--fps', '--from', '--to'].includes(key) || !value || values.has(key)) {
    throw new Error('Usage: node scripts/p3-throughput.mjs [--ffmpeg path] [--cli path] [--fps 30] [--from 0] [--to 60]')
  }
  values.set(key, value)
}
await mkdir(cache, { recursive: true })

// Reuse the existing font and exact TS preprocessing/codec, without maintaining a second
// font or teaching templates from this recording to influence recognition outcomes.
for (const [source, name] of [
  ['src/core/profileSchema.ts', 'profileSchema'],
  ['src/core/imageOps.ts', 'imageOps'],
  ['src/core/bitmapCodec.ts', 'bitmapCodec'],
  ['src/test/glyphFont.ts', 'glyphFont'],
]) {
  const input = await readFile(path.join(root, source), 'utf8')
  const output = ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/from '\.\/profileSchema'/g, "from './profileSchema.mjs'")
  await writeFile(path.join(cache, `${name}.mjs`), output)
}
const { createEmptyProfile, CLOCK_CHARS } = await import(pathToFileURL(path.join(cache, 'profileSchema.mjs')).href)
const { normalizeGlyph } = await import(pathToFileURL(path.join(cache, 'imageOps.mjs')).href)
const { packBitmap } = await import(pathToFileURL(path.join(cache, 'bitmapCodec.mjs')).href)
const { renderGlyphMask } = await import(pathToFileURL(path.join(cache, 'glyphFont.mjs')).href)
const profile = createEmptyProfile('benchmark/untuned', '未调优吞吐基准')
profile.notes = 'No broadcast preset exists. Default ROI and synthetic test-font templates only. Throughput does not establish recognition accuracy.'
profile.templates = Object.fromEntries(CLOCK_CHARS.map((char) => [char, [{
  id: `synthetic-${char}`,
  data: packBitmap(normalizeGlyph(renderGlyphMask(char))),
  createdAt: 0,
  origin: 'src/test/glyphFont.ts',
}]]))
const profilePath = path.join(cache, 'untuned-profile.json')
await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`)

const executable = values.get('--cli') ?? path.join(root, 'target', 'release', `stream-syncer-cli${process.platform === 'win32' ? '.exe' : ''}`)
const args = [
  'offset', '--profile', profilePath,
  '--official', path.join(root, 'prototype', '.media', '2026-10-18T20-19-14-448Z', 'official-youtube.ts'),
  '--commentary', path.join(root, 'prototype', '.media', '2026-10-18T20-19-14-448Z', 'commentary-douyu.ts'),
  '--from', values.get('--from') ?? '0',
  '--to', values.get('--to') ?? '60',
  '--fps', values.get('--fps') ?? '30',
]
if (values.has('--ffmpeg')) args.push('--ffmpeg', values.get('--ffmpeg'))
console.error('使用默认 ROI 和既有合成字体模板, 未针对录像调优. 结果仅用于吞吐测量.')
const child = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], shell: false, windowsHide: true })
const lines = []
let pending = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  pending += chunk
  let newline
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (!line.trim()) continue
    lines.push(line)
    console.log(line)
  }
})
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (pending.trim()) lines.push(pending)
await writeFile(path.join(cache, 'results.jsonl'), `${lines.join('\n')}\n`)
if (exitCode !== 0) throw new Error(`CLI exited with code ${exitCode}`)
