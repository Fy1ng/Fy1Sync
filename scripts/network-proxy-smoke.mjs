/** Offline proxy smoke test. Every listener and upstream connection is loopback-only. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const stamp = new Date().toISOString().replace(/[^0-9]/g, '')
const directory = path.join(root, '.runtime-cache', 'codex-network-impl-20261030-implementation', `proxy-smoke-${stamp}`)
await mkdir(directory, { recursive: true })
const entry = path.join(directory, 'entry.ts')
await writeFile(entry, [
  `export { safeFetch } from ${JSON.stringify(path.join(root, 'server/safeFetch.ts').replaceAll('\\', '/'))}`,
  `export { MediaGateway } from ${JSON.stringify(path.join(root, 'electron/mediaGateway.ts').replaceAll('\\', '/'))}`,
  `export { buildFfmpegArgs, parseHlsSegments } from ${JSON.stringify(path.join(root, 'electron/bufferManager.ts').replaceAll('\\', '/'))}`,
  `export { cleanProxyEnvironment } from ${JSON.stringify(path.join(root, 'server/networkPolicy.ts').replaceAll('\\', '/'))}`,
  `export { classifyFfmpegStderr } from ${JSON.stringify(path.join(root, 'server/networkFailure.ts').replaceAll('\\', '/'))}`,
].join('\n') + '\n', { flag: 'wx' })
const compiled = await build({ configFile: false, root, logLevel: 'silent',
  build: { ssr: entry, write: false, emptyOutDir: false, minify: false, target: 'node22',
    rollupOptions: { external: [/^node:/, 'undici'], output: { format: 'cjs', entryFileNames: 'probe.cjs', codeSplitting: false } },
  },
})
for (const output of (Array.isArray(compiled) ? compiled : [compiled])) for (const asset of output.output) {
  await writeFile(path.join(directory, asset.fileName), asset.type === 'chunk' ? asset.code : asset.source, { flag: 'wx' })
}
const { safeFetch, MediaGateway, buildFfmpegArgs, parseHlsSegments, cleanProxyEnvironment, classifyFfmpegStderr } = createRequire(import.meta.url)(path.join(directory, 'probe.cjs'))
const sampleDirectory = path.join(directory, 'sample')
await mkdir(sampleDirectory)
async function generate(file, args) {
  await new Promise((yes, no) => {
    const child = spawn(file, args, { cwd: sampleDirectory, shell: false, windowsHide: true, stdio: 'ignore', env: cleanProxyEnvironment(process.env) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('Local fixture generation timed out')) }, 15_000)
    child.once('error', () => { clearTimeout(timer); no(new Error('Local fixture generator unavailable; set STREAM_SYNC_FIXTURE_FFMPEG')) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? yes() : no(new Error('Local fixture generation failed')) })
  })
}
await generate(process.env.STREAM_SYNC_FIXTURE_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
  '-t', '36', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0', 'long-gop.mp4'])
await generate(path.join(root, '.packaging/tools/ffmpeg/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-i', 'long-gop.mp4', '-c', 'copy',
  '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', 'long-gop-segment-%03d.ts', 'long-gop.m3u8'])
const media = await readFile(path.join(sampleDirectory, 'long-gop.mp4'))
const resources = new Map([
  ['/long-gop.mp4', { bytes: media, type: 'video/mp4' }],
  ['/long-gop.m3u8', { bytes: Buffer.from((await readFile(path.join(sampleDirectory, 'long-gop.m3u8'), 'utf8')) + '\n#EXT-X-ENDLIST\n'), type: 'application/vnd.apple.mpegurl' }],
  ['/long-gop-segment-000.ts', { bytes: await readFile(path.join(sampleDirectory, 'long-gop-segment-000.ts')), type: 'video/mp2t' }],
  ['/long-gop-segment-001.ts', { bytes: await readFile(path.join(sampleDirectory, 'long-gop-segment-001.ts')), type: 'video/mp2t' }],
])
const counts = { origin: 0, originMedia: 0, originPlaylist: 0, originSegments: 0, originProbe: 0, proxyConnect: 0, proxyHttp: 0, rejectedProxyTargets: 0, localDns: 0 }
const sockets = new Set()
const watched = server => {
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return server
}
const listen = server => new Promise((yes, no) => {
  server.once('error', no)
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', no); yes(server.address().port) })
})
const origin = watched(createServer((request, response) => {
  counts.origin++
  if (request.url === '/probe') {
    counts.originProbe++
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 13 })
    response.end('offline-proxy')
    return
  }
  const resource = resources.get(request.url)
  if (!resource) { response.writeHead(404); response.end(); return }
  counts.originMedia++
  if (request.url.endsWith('.m3u8')) counts.originPlaylist++
  if (request.url.endsWith('.ts')) counts.originSegments++
  const bytes = resource.bytes
  let start = 0, end = bytes.length - 1
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (range) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])) }
  if (start > end || start >= bytes.length) { response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }); response.end(); return }
  const headers = { 'content-type': resource.type, 'content-length': end - start + 1, 'accept-ranges': 'bytes' }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`
  response.writeHead(range ? 206 : 200, headers)
  response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1))
}))
let originPort
const proxy = watched(createServer((request, response) => {
  let target
  try { target = new URL(request.url) } catch { response.writeHead(400); response.end(); return }
  if (target.protocol !== 'http:' || target.hostname !== 'fixture.invalid' || target.port || target.username || target.password) {
    counts.rejectedProxyTargets++; response.writeHead(403); response.end(); return
  }
  counts.proxyHttp++
  const upstream = httpRequest({ hostname: '127.0.0.1', port: originPort, method: request.method, path: target.pathname,
    headers: { ...request.headers, host: 'fixture.invalid' } }, source => { response.writeHead(source.statusCode, source.headers); source.pipe(response) })
  upstream.on('error', () => { response.destroy() })
  request.pipe(upstream)
}))
proxy.on('connect', (request, client, head) => {
  if (request.url !== 'fixture.invalid:80') { counts.rejectedProxyTargets++; client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  counts.proxyConnect++
  const upstream = connect({ host: '127.0.0.1', port: originPort }, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  sockets.add(upstream)
  upstream.once('close', () => sockets.delete(upstream))
  upstream.on('error', () => client.destroy())
  client.on('error', () => upstream.destroy())
  client.on('close', () => upstream.destroy())
})
let gateway
const results = {}
const before = () => ({ ...counts })
const delta = previous => Object.fromEntries(Object.keys(counts).map(key => [key, counts[key] - previous[key]]))
async function ffmpeg(input, name) {
  const output = path.join(directory, name)
  await mkdir(output)
  const args = buildFfmpegArgs(input, output, 1)
  const index = args.indexOf('-http_proxy')
  assert(index >= 0 && args[index + 1] === input.proxyUrl, 'FFmpeg must receive the selected explicit proxy')
  const env = cleanProxyEnvironment({ ...process.env, http_proxy: 'http://inherited.invalid:1', HTTPS_PROXY: 'http://inherited.invalid:2', ALL_PROXY: 'socks5://inherited.invalid:3', no_proxy: '*' })
  assert(!Object.keys(env).some(key => /^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key)), 'FFmpeg inherited proxy variables were not removed')
  let failure, optionFailure, maxFrame = 0
  let progress = ''
  await new Promise((yes, no) => {
    const child = spawn(path.join(root, '.packaging', 'tools', 'ffmpeg', 'ffmpeg.exe'), args, { cwd: output, shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(new Error('FFmpeg local smoke timed out')) }, 30_000)
    child.once('error', () => { clearTimeout(timer); no(new Error('FFmpeg local smoke could not start')) })
    child.stdout.on('data', chunk => {
      progress = (progress + chunk.toString('utf8')).slice(-4096)
      const lines = progress.split(/\r?\n/)
      progress = lines.pop() ?? ''
      for (const line of lines) if (/^frame=\d+$/.test(line)) maxFrame = Math.max(maxFrame, Number(line.slice(6)))
    })
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      if (/Option tls_verify not found/i.test(text)) optionFailure = 'http-input-rejected-tls-option'
      if (/not in allowed_(?:segment_)?extensions|extension.*(?:not allowed|is not)|extension mismatch/i.test(text)) optionFailure = 'hls-capability-extension-rejected'
      if (/Error when loading first segment|Failed to open segment/i.test(text)) optionFailure ??= 'hls-segment-open-failed'
      failure = classifyFfmpegStderr(text) ?? failure
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) no(new Error(`FFmpeg local smoke ${name} failed: ${optionFailure ?? failure?.code ?? 'unclassified'} (${code})`))
      else yes()
    })
  })
  const manifest = parseHlsSegments(await readFile(path.join(output, 'raw_1.m3u8'), 'utf8'))
  assert(manifest.segments.length >= 1, 'FFmpeg produced no complete segment')
  assert(maxFrame > 0, 'FFmpeg reported no video frames')
  for (const segment of manifest.segments) assert((await readFile(path.join(output, segment.uri))).length > 0, 'FFmpeg produced an empty segment')
  return { exitCode: 0, completeSegments: manifest.segments.length, seconds: manifest.segments.reduce((sum, value) => sum + value.duration, 0), videoFrames: maxFrame,
    explicitProxy: input.proxyUrl ? 'HTTP' : 'DIRECT', proxyEnvironmentCleared: true }
}
try {
  originPort = await listen(origin)
  const proxyPort = await listen(proxy)
  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  const network = { route: async () => ({ kind: 'http', proxyUrl }) }
  const resolve = async () => { counts.localDns++; throw new Error('Local DNS is forbidden in the proxy smoke test') }
  const config = { enabled: true, hosts: ['fixture.invalid'], allowNonStandardPorts: false, maxRedirects: 2, requestTimeoutMs: 10_000 }
  let previous = before()
  const response = await safeFetch('http://fixture.invalid/probe', config, { network, resolve })
  assert.equal(await response.response.text(), 'offline-proxy')
  results.node = { status: response.response.status, counts: delta(previous) }
  assert(results.node.counts.proxyConnect > 0 && results.node.counts.localDns === 0, 'Node request did not use proxy CONNECT')
  previous = before()
  results.nativeFfmpeg = await ffmpeg({ url: 'http://fixture.invalid/long-gop.mp4', proxyUrl }, 'native-ffmpeg')
  results.nativeFfmpeg.counts = delta(previous)
  assert(results.nativeFfmpeg.counts.proxyHttp > 0, 'Native FFmpeg request bypassed the proxy')
  gateway = new MediaGateway(config, { resolve })
  const input = await gateway.register('http://fixture.invalid/long-gop.mp4', undefined, network)
  previous = before()
  results.gatewayFfmpeg = await ffmpeg(input, 'gateway-ffmpeg')
  results.gatewayFfmpeg.counts = delta(previous)
  results.gatewayFfmpeg.upstreamFailure = input.readFailure() ?? null
  assert(results.gatewayFfmpeg.counts.proxyConnect > 0 && results.gatewayFfmpeg.counts.localDns === 0, 'Gateway request did not use the Node proxy')
  const hls = await gateway.register('http://fixture.invalid/long-gop.m3u8', undefined, network)
  const hlsRange = await fetch(hls.url, { headers: { range: 'bytes=0-' } })
  const hlsText = await hlsRange.text()
  results.gatewayHlsProbe = { status: hlsRange.status, opaqueSegments: hlsText.includes('/media/'), originalSegments: hlsText.includes('long-gop-segment') }
  previous = before()
  results.gatewayHlsFfmpeg = await ffmpeg({ ...hls, gatewayHls: true }, 'gateway-hls-ffmpeg')
  results.gatewayHlsFfmpeg.counts = delta(previous)
  results.gatewayHlsFfmpeg.upstreamFailure = hls.readFailure() ?? null
  assert(results.gatewayHlsFfmpeg.counts.originPlaylist > 0 && results.gatewayHlsFfmpeg.counts.originSegments >= 2, 'Gateway did not retrieve the HLS playlist and nested segments')
  assert.equal(counts.rejectedProxyTargets, 0)
  assert.equal(counts.localDns, 0)
  const summary = { ok: true, test: 'loopback-proxy-smoke', ...results, counts }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
} catch (error) {
  const summary = { ok: false, test: 'loopback-proxy-smoke', ...results, counts,
    failure: error instanceof Error && /^FFmpeg local smoke /.test(error.message) ? error.message : 'local-smoke-assertion-failed' }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  process.exitCode = 1
} finally {
  await gateway?.dispose()
  for (const socket of sockets) socket.destroy()
  await Promise.all([origin, proxy].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections() })))
}
