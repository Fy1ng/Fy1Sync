/** Replay local captures without printing raw frames, chat, user IDs or upstream errors. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, process.argv[2] ?? '.runtime-cache/huya-h2-claude')
let loader
try {
  loader = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } })
  const { decodeHuyaFrame } = await loader.ssrLoadModule('/server/danmaku/huyaProtocol.ts')
  const names = (await readdir(directory)).filter(name => /^raw-[A-Za-z0-9_-]{1,64}-(group|userInfo)\.json$/.test(name)).sort()
  const files = names.map(name => ({ name, path: join(directory, name) }))
  for (const name of ['kpl.json', '117736.json']) {
    try { await readFile(join(directory, 'frames', name)); files.push({ name: `frames/${name}`, path: join(directory, 'frames', name) }) }
    catch { /* Older captures are optional. */ }
  }
  if (files.length === 0 || files.length > 32) throw new Error()
  const totals = { frames: 0, chats: 0, gifts: 0, viewerSignals: 0, unknownUris: 0, failures: 0, emptyFrames: 0, nonEmptyFailures: 0 }
  const unknownUriCounts = {}
  const results = []
  for (const file of files) {
    const json = await readFile(file.path, 'utf8')
    if (json.length > 8 * 1_048_576) throw new Error()
    const entries = JSON.parse(json)
    if (!Array.isArray(entries) || entries.length > 1024) throw new Error()
    const room = file.name.includes('117736') ? '117736' : file.name.includes('a16789') ? '528300' : '660002'
    const row = { file: file.name, frames: entries.length, chats: 0, gifts: 0, viewerSignals: 0, unknownUris: 0,
      failures: 0, emptyFrames: 0, nonEmptyFailures: 0, unknownUriCounts: {}, commands: {}, emptyIndices: [], invalidIndices: [],
      minViewerCount: null, maxViewerCount: null }
    for (const [index, entry] of entries.entries()) {
      if (typeof entry.hex !== 'string' || entry.hex.length > 2 * 1_048_576 || !/^(?:[a-fA-F0-9]{2})*$/.test(entry.hex)) throw new Error()
      const decoded = decodeHuyaFrame(Buffer.from(entry.hex, 'hex'), room, 0)
      const command = decoded.emptyFrame ? 'empty' : decoded.command === null ? 'unavailable' : String(decoded.command)
      row.commands[command] = (row.commands[command] ?? 0) + 1
      if (decoded.emptyFrame) { row.emptyFrames++; row.emptyIndices.push(index) }
      if (decoded.malformed) {
        row.failures++
        row.nonEmptyFailures++; row.invalidIndices.push(index)
      }
      row.chats += decoded.messages.filter(message => !message.system).length
      row.gifts += decoded.messages.filter(message => message.system).length
      row.viewerSignals += decoded.signals.length
      row.unknownUris += decoded.unknownUris
      for (const signal of decoded.signals) {
        row.minViewerCount = Math.min(row.minViewerCount ?? signal.count, signal.count)
        row.maxViewerCount = Math.max(row.maxViewerCount ?? signal.count, signal.count)
      }
      for (const [uri, count] of Object.entries(decoded.unknownUriCounts)) {
        row.unknownUriCounts[uri] = (row.unknownUriCounts[uri] ?? 0) + count
        unknownUriCounts[uri] = (unknownUriCounts[uri] ?? 0) + count
      }
    }
    for (const key of Object.keys(totals)) totals[key] += row[key]
    results.push(row)
  }
  const report = { captureDate: '2026-10-27', source: basename(directory), indexBase: 0,
    emptyFrameExplanation: 'Host validation confirmed genuine zero-length ArrayBuffer messages from Huya. Listed indices are ignored empty binary frames, counted only in emptyFrames, never failures.',
    totals, unknownUriCounts, files: results }
  const output = JSON.stringify(report, null, 2) + '\n'
  if (process.argv[3]) await writeFile(resolve(root, process.argv[3]), output, 'utf8')
  console.log(output)
  if (totals.nonEmptyFailures > 0) process.exitCode = 1
} catch {
  console.error('虎牙本地帧重放失败, 请检查目录、记录格式和运行环境.')
  process.exitCode = 1
} finally { await loader?.close() }
