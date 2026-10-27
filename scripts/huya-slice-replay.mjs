/** Offline replay. Output contains aggregate counters only, never identities or frame bytes. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, process.argv[2] ?? '.runtime-cache/huya-h2-web')
const names = ['chat-slice-long.bin', 'slice-5.bin', 'slice-6.bin', 'chat-slice.bin']
let loader
try {
  loader = await createServer({ root, configFile: false, envFile: false, logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null } })
  const { HuyaSliceParser } = await loader.ssrLoadModule('/server/danmaku/huyaSlice.ts')
  const { decodeHuyaPush } = await loader.ssrLoadModule('/server/danmaku/huyaProtocol.ts')
  const files = []
  const chatIds = new Map()
  for (const file of names) {
    const raw = await readFile(join(directory, file))
    if (raw.length > 64 * 1_048_576) throw new Error()
    const ids = []
    const row = { file, bytes: raw.length, chats: 0, gifts: 0, viewerSignals: 0,
      unknownUris: 0, uriCounts: {}, pushDecodeFailures: 0 }
    const parser = new HuyaSliceParser(bytes => {
      const result = decodeHuyaPush(bytes, '528300', 0)
      if (result.malformed) { row.pushDecodeFailures++; return }
      for (const message of result.messages) {
        const parts = message.id.split(':')
        const uri = parts[2]
        row.uriCounts[uri] = (row.uriCounts[uri] ?? 0) + 1
        if (message.system) row.gifts++
        else { row.chats++; ids.push(parts[3]) }
      }
      for (const _signal of result.signals) {
        row.viewerSignals++
        row.uriCounts['8006'] = (row.uriCounts['8006'] ?? 0) + 1
      }
      row.unknownUris += result.unknownUris
      for (const [uri, count] of Object.entries(result.unknownUriCounts)) row.uriCounts[uri] = (row.uriCounts[uri] ?? 0) + count
    })
    for (let offset = 0; offset < raw.length; offset += 16_384) parser.feed(raw.subarray(offset, offset + 16_384))
    files.push({ ...row, ...parser.diagnostics })
    chatIds.set(file, ids)
  }
  const comparisons = []
  for (const sample of ['5', '6']) {
    const reports = JSON.parse(await readFile(join(directory, `client-report-${sample}.json`), 'utf8'))
    const report = reports[0]
    const slice = chatIds.get(`slice-${sample}.bin`)
    const client = report.chatSamples.filter(value => !value.system).map(value => value.id.split(':').at(-1))
    if (!slice.length || !client.length || ![...slice, ...client].every(value => /^\d{1,20}$/.test(value))) throw new Error()
    const monotonic = values => values.every((value, index) => index === 0 || BigInt(value) >= BigInt(values[index - 1]))
    if (!monotonic(slice) || !monotonic(client)) throw new Error()
    const sortedSlice = slice.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const sortedClient = client.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const lo = sortedSlice[0] > sortedClient[0] ? sortedSlice[0] : sortedClient[0]
    const hi = sortedSlice.at(-1) < sortedClient.at(-1) ? sortedSlice.at(-1) : sortedClient.at(-1)
    const inWindow = value => BigInt(value) >= lo && BigInt(value) <= hi
    const sliceWindow = slice.filter(inWindow)
    const clientWindow = client.filter(inWindow)
    const sliceSet = new Set(sliceWindow)
    const clientSet = new Set(clientWindow)
    comparisons.push({ sample, windowDefinition: 'common numeric lMsgId interval; observed IDs verified monotonic', sliceAll: slice.length, clientAll: client.length,
      sliceOverlap: sliceWindow.length, clientOverlap: clientWindow.length,
      onlySlice: sliceWindow.filter(value => !clientSet.has(value)).length,
      onlyClient: clientWindow.filter(value => !sliceSet.has(value)).length })
  }
  const report = { captureDate: '2026-10-27', files, comparisons }
  const text = JSON.stringify(report, null, 2) + '\n'
  if (process.argv[3]) await writeFile(resolve(root, process.argv[3]), text, 'utf8')
  console.log(text)
  if (files.some(row => row.pushDecodeFailures || row.malformedPackets || row.malformedBlocks || row.inflateFailures || row.fragmentFailures)) process.exitCode = 1
} catch {
  console.error('虎牙 slice 离线重放失败, 请检查输入文件与运行环境.')
  process.exitCode = 1
} finally { await loader?.close() }
