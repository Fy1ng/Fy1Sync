/** Local release probe. Keep this function self-contained for Electron/worker evaluation. */
export async function probePackagedNetwork(_electron, { runtimePath, mode, expectedVersion }) {
  const { createServer } = process.getBuiltinModule('node:http')
  const { createHash } = process.getBuiltinModule('node:crypto')
  const { createRequire } = process.getBuiltinModule('node:module')
  const require = createRequire(runtimePath)
  const names = ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'WebSocket']
  let runtime, preloaded = false
  if (mode !== 'main') {
    preloaded = !!require.cache[require.resolve(runtimePath)]
    if (mode === 'node-options' && !preloaded) throw new Error('Packaged NODE_OPTIONS runtime was not preloaded')
    runtime = require(runtimePath)
    if (runtime.networkRuntimeVersion !== expectedVersion) throw new Error('Unexpected packaged network runtime version')
  }
  const globals = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  for (const name of names) {
    if (typeof globals[name] !== 'function' || (runtime && globals[name] !== runtime[name])) throw new Error('Mixed packaged networking globals: ' + name)
  }
  const sockets = new Set(), timers = new Set()
  const expectedBytes = [0, 1, 128, 255]
  let outgoing = null, dispatcher, websocket
  const server = createServer((request, response) => {
    if (request.url === '/echo') {
      let size = 0
      const chunks = []
      request.on('error', () => response.destroy())
      request.on('data', chunk => { size += chunk.length; if (size > 8192) request.destroy(); else chunks.push(chunk) })
      request.on('end', () => { response.writeHead(200, { 'Content-Type': request.headers['content-type'] ?? 'text/plain' }); response.end(Buffer.concat(chunks)) })
    } else if (request.url === '/malformed') {
      response.writeHead(200, { 'Content-Encoding': 'gzip, gzip, gzip, gzip, gzip, gzip', 'Content-Length': '100' })
      response.flushHeaders()
      const timer = setTimeout(() => { timers.delete(timer); response.destroy() }, 25)
      timers.add(timer)
    } else response.writeHead(404).end()
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (request, peer) => {
    const key = request.headers['sec-websocket-key']
    if (request.url !== '/socket' || typeof key !== 'string') { peer.destroy(); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    let buffer = Buffer.alloc(0)
    peer.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15, length = buffer[1] & 127
        if (length >= 126 || !(buffer[1] & 128)) { peer.destroy(); return }
        if (buffer.length < 6 + length) return
        const body = buffer.subarray(6, 6 + length).map((value, index) => value ^ buffer[2 + index % 4])
        buffer = buffer.subarray(6 + length)
        if (opcode === 2) { outgoing = [...body]; peer.write(Buffer.from([0x82, body.length, ...body])) }
        else if (opcode === 8) { peer.end(Buffer.from([0x88, body.length, ...body])); return }
        else { peer.destroy(); return }
      }
    })
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    if (runtime) dispatcher = runtime.createPinnedDispatcher('127.0.0.1', ['127.0.0.1'])
    const options = dispatcher ? { dispatcher } : {}
    const form = new globals.FormData()
    form.append('probe', 'stream-syncer-local-only')
    const request = new globals.Request('http://127.0.0.1:' + port + '/echo', {
      method: 'POST', body: form, headers: new globals.Headers({ 'x-network-probe': 'local' }), signal: AbortSignal.timeout(5000),
    })
    if (!(request.headers instanceof globals.Headers)) throw new Error('Request uses a different Headers implementation')
    const response = await globals.fetch(request, options)
    if (!(response instanceof globals.Response) || !(response.headers instanceof globals.Headers)) throw new Error('Fetch uses different Response or Headers implementations')
    const echoed = await response.formData()
    if (!(echoed instanceof globals.FormData) || echoed.get('probe') !== 'stream-syncer-local-only') throw new Error('Request/fetch/FormData interoperability failed')
    const incoming = await new Promise((resolve, reject) => {
      websocket = new globals.WebSocket('ws://127.0.0.1:' + port + '/socket', options)
      websocket.binaryType = 'arraybuffer'
      const timer = setTimeout(() => reject(new Error('Packaged WebSocket probe timed out')), 5000)
      timers.add(timer)
      websocket.addEventListener('open', () => websocket.send(Uint8Array.from(expectedBytes)))
      websocket.addEventListener('message', event => {
        clearTimeout(timer); timers.delete(timer)
        if (!(event.data instanceof ArrayBuffer)) reject(new Error('Packaged WebSocket did not return binary data'))
        else resolve([...new Uint8Array(event.data)])
      }, { once: true })
      websocket.addEventListener('error', () => { clearTimeout(timer); timers.delete(timer); reject(new Error('Packaged WebSocket probe failed')) }, { once: true })
    })
    if (JSON.stringify(incoming) !== JSON.stringify(expectedBytes) || JSON.stringify(outgoing) !== JSON.stringify(expectedBytes)) throw new Error('Packaged WebSocket changed binary data')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged WebSocket close timed out')), 5000)
      timers.add(timer)
      websocket.addEventListener('close', () => { clearTimeout(timer); timers.delete(timer); resolve() }, { once: true })
      websocket.close(1000)
    })
    let malformedRejected = false
    try {
      const invalid = await globals.fetch('http://127.0.0.1:' + port + '/malformed', { ...options, signal: AbortSignal.timeout(5000) })
      await invalid.text()
    } catch { malformedRejected = true }
    // Leave unhandled response errors time to surface; do not install an exception handler.
    await new Promise(resolve => setTimeout(resolve, 150))
    if (!malformedRejected) throw new Error('Malformed response did not reject')
    if (names.some(name => globalThis[name] !== globals[name])) throw new Error('Network probe replaced application networking globals')
    return { mode, version: runtime?.networkRuntimeVersion ?? null,
      versionSource: runtime ? 'physical-runtime-export' : 'not-exposed-by-main-bundle', preloaded, globals: names, globalsUnchanged: true,
      requestCompatible: true, incoming, outgoing, malformedRejected, survived: true, electron: process.versions.electron }
  } finally {
    for (const timer of timers) clearTimeout(timer)
    if (websocket?.readyState === 1) websocket.close(1000)
    await dispatcher?.destroy()
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

/** Exercise the same physical runtime in an isolated Node process and worker. */
export function packagedNodeProbeProgram(options) {
  const probe = probePackagedNetwork.toString()
  const workerOptions = { ...options, mode: 'worker' }
  const workerCode = `const { parentPort, workerData } = require('node:worker_threads'); (${probe})(null, workerData).then(value => parentPort.postMessage(value)).catch(error => { throw error });`
  return `(async () => {
    const result = await (${probe})(null, ${JSON.stringify(options)});
    const { Worker } = require('node:worker_threads');
    const workerResult = await new Promise((resolve, reject) => {
      let completed = false;
      const worker = new Worker(${JSON.stringify(workerCode)}, { eval: true, execArgv: [], workerData: ${JSON.stringify(workerOptions)}, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      const timer = setTimeout(() => { completed = true; void worker.terminate(); reject(new Error('Packaged worker probe timed out')); }, 15000);
      worker.once('error', error => { clearTimeout(timer); completed = true; reject(error); });
      worker.once('exit', code => { if (!completed) { clearTimeout(timer); completed = true; reject(new Error('Packaged worker exited without result: ' + code)); } });
      worker.once('message', value => { clearTimeout(timer); completed = true; void worker.terminate().then(() => resolve(value), reject); });
    });
    console.log(JSON.stringify({ node: result, worker: workerResult }));
  })().catch(error => { console.error(error); process.exitCode = 1; });`
}
