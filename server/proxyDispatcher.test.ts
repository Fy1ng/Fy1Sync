import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { fetch as undiciFetch, WebSocket, type Dispatcher } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_PROXY_KEEP_ALIVE_TIMEOUT_MS,
  createProxyDispatcher,
  isProxyConnectFailure,
  markProxyConnectFailure,
} from './proxyDispatcher'
import { TEST_TLS_CERT, TEST_TLS_KEY } from './networkTls.testFixture'

const cleanup: Array<() => Promise<void>> = []
const owned: Dispatcher[] = []
afterEach(async () => {
  await Promise.all(owned.splice(0).map(dispatcher => dispatcher.destroy().catch(() => {})))
  for (const release of cleanup.splice(0).reverse()) await release()
})

async function listen(server: Server): Promise<{ port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { port: (server.address() as { port: number }).port, sockets }
}

async function socks(options: { targetPort?: number; auth?: boolean; rejectAuth?: boolean; rejectConnect?: boolean; stall?: boolean; stallFirst?: boolean; fragment?: boolean } = {}) {
  const requests: Array<{ host: string; port: number; type: number }> = []
  const credentials: string[] = []
  const upstreams = new Set<Socket>()
  let accepted = 0
  const server = createServer(socket => {
    const stall = options.stall || options.stallFirst && accepted++ === 0
    let state = 'greeting', buffered = Buffer.alloc(0)
    const reply = (bytes: number[]) => {
      if (!options.fragment) { socket.write(Buffer.from(bytes)); return }
      socket.write(Buffer.from(bytes.slice(0, 1)))
      setImmediate(() => { if (!socket.destroyed) socket.write(Buffer.from(bytes.slice(1))) })
    }
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (state === 'greeting') {
        if (buffered.length < 2 || buffered.length < buffered[1]! + 2) return
        buffered = buffered.subarray(buffered[1]! + 2)
        if (stall) return
        state = options.auth ? 'auth' : 'connect'; reply([5, options.auth ? 2 : 0]); return
      }
      if (state === 'auth') {
        if (buffered.length < 2 || buffered.length < buffered[1]! + 3) return
        const endUser = buffered[1]! + 2, length = endUser + 1 + buffered[endUser]!
        if (buffered.length < length) return
        credentials.push(buffered.subarray(2, endUser).toString(), buffered.subarray(endUser + 1, length).toString())
        buffered = buffered.subarray(length); state = 'connect'; reply([1, options.rejectAuth ? 1 : 0]); return
      }
      if (state !== 'connect' || buffered.length < 5) return
      const type = buffered[3]!, length = type === 3 ? buffered[4]! + 7 : type === 1 ? 10 : 22
      if (buffered.length < length) return
      const host = type === 3 ? buffered.subarray(5, length - 2).toString() : type === 1 ? [...buffered.subarray(4, 8)].join('.') : 'ipv6'
      requests.push({ host, port: buffered.readUInt16BE(length - 2), type })
      buffered = buffered.subarray(length)
      if (options.rejectConnect) { reply([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]); return }
      if (!options.targetPort) return
      state = 'tunnel'; socket.removeListener('data', data)
      const upstream = connect(options.targetPort, '127.0.0.1')
      upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream))
      upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy())
      upstream.once('connect', () => {
        reply([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
        if (buffered.length) upstream.write(buffered)
        socket.pipe(upstream); upstream.pipe(socket)
      })
    }
    socket.on('data', data)
  })
  const listener = await listen(server)
  cleanup.push(async () => { for (const socket of upstreams) socket.destroy() })
  return { ...listener, requests, credentials, url: `socks5://127.0.0.1:${listener.port}` }
}

function dispatcher(proxyUrl: string, timeoutMs = 1000, kind: 'socks5' | 'http' = 'socks5') {
  const value = createProxyDispatcher({ kind, proxyUrl }, timeoutMs)
  owned.push(value)
  return value
}

describe('proxy dispatcher transport', () => {
  it('uses the SOCKS5 domain request and username authentication without local target DNS', async () => {
    const target = await listen(createHttpServer((request, response) => response.end(`proxied:${request.url}`)))
    const proxy = await socks({ targetPort: target.port, auth: true, fragment: true })
    const route = dispatcher(proxy.url.replace('://', '://fixture-user:fixture-password@'))
    const response = await undiciFetch('http://unresolvable.fixture.invalid/live', { dispatcher: route })
    expect(await response.text()).toBe('proxied:/live')
    expect(proxy.requests).toEqual([{ host: 'unresolvable.fixture.invalid', port: 80, type: 3 }])
    expect(proxy.credentials).toEqual(['fixture-user', 'fixture-password'])
  })

  it('preserves origin identity in pooled SOCKS5 requests', async () => {
    const hosts: Array<string | undefined> = []
    const target = await listen(createHttpServer((request, response) => { hosts.push(request.headers.host); response.end('ok') }))
    const proxy = await socks({ targetPort: target.port })
    const route = dispatcher(proxy.url)
    for (const host of ['first.fixture.invalid', 'second.fixture.invalid']) {
      expect(await (await undiciFetch(`http://${host}/`, { dispatcher: route })).text()).toBe('ok')
    }
    expect(proxy.requests.map(request => request.host)).toEqual(['first.fixture.invalid', 'second.fixture.invalid'])
    expect(hosts).toEqual(['first.fixture.invalid', 'second.fixture.invalid'])
  })

  it('applies the configured connection limit to SOCKS5 pools', async () => {
    const target = await listen(createHttpServer((_request, response) => setTimeout(() => response.end('ok'), 10)))
    const proxy = await socks({ targetPort: target.port })
    const route = dispatcher(proxy.url)
    expect(await Promise.all(Array.from({ length: 4 }, async () => (await undiciFetch('http://fixture.invalid/', { dispatcher: route })).text())))
      .toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(proxy.requests).toHaveLength(1)
  })

  it('rejects an untrusted target TLS certificate after establishing SOCKS5', async () => {
    const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_request, response) => response.end('unsafe'))
    server.on('tlsClientError', () => {})
    const target = await listen(server)
    const proxy = await socks({ targetPort: target.port })
    let rejected: unknown
    try { await undiciFetch('https://fixture.invalid/', { dispatcher: dispatcher(proxy.url) }) } catch (error) { rejected = error }
    expect(rejected).toBeDefined()
    expect(isProxyConnectFailure(rejected)).toBe(false)
    expect(proxy.requests).toEqual([{ host: 'fixture.invalid', port: 443, type: 3 }])
  })

  it.each([{ auth: true, rejectAuth: true }, { rejectConnect: true }])('never considers a SOCKS authentication or policy rejection a fallback: %j', async options => {
    const proxy = await socks(options)
    let rejected: unknown
    try { await undiciFetch('http://fixture.invalid/', { dispatcher: dispatcher(proxy.url.replace('://', '://user:pass@')) }) } catch (error) { rejected = error }
    expect(rejected).toBeDefined()
    expect(isProxyConnectFailure(rejected)).toBe(false)
  })

  it('marks a real refused proxy connection and preserves the marker through fetch causes', async () => {
    const server = createServer()
    const listener = await listen(server)
    await new Promise<void>(resolve => server.close(() => resolve()))
    let rejected: unknown
    try { await undiciFetch('http://fixture.invalid/', { dispatcher: dispatcher(`socks5://127.0.0.1:${listener.port}`) }) } catch (error) { rejected = error }
    expect(isProxyConnectFailure(rejected)).toBe(true)
  })

  it('routes HTTP through CONNECT while preserving the proxy-side target name', async () => {
    const target = await listen(createHttpServer((request, response) => response.end(request.headers.host)))
    const paths: string[] = []
    const server = createHttpServer()
    const upstreams = new Set<Socket>()
    server.on('connect', (request, socket, head) => {
      paths.push(request.url!)
      const upstream = connect(target.port, '127.0.0.1')
      upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream))
      upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy())
      upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
    })
    const proxy = await listen(server)
    cleanup.push(async () => { for (const socket of upstreams) socket.destroy() })
    expect(await (await undiciFetch('http://unresolvable.fixture.invalid/', { dispatcher: dispatcher(`http://127.0.0.1:${proxy.port}`, 1000, 'http') })).text())
      .toBe('unresolvable.fixture.invalid')
    expect(paths).toEqual(['unresolvable.fixture.invalid:80'])
  })

  it('marks refused HTTP proxy sockets but never treats CONNECT 407 as a connection fallback', async () => {
    const server = createServer()
    const closed = await listen(server)
    await new Promise<void>(resolve => server.close(() => resolve()))
    let refused: unknown
    try { await undiciFetch('https://fixture.invalid/', { dispatcher: dispatcher(`http://127.0.0.1:${closed.port}`, 1000, 'http') }) } catch (error) { refused = error }
    expect(isProxyConnectFailure(refused)).toBe(true)
    const rejecting = createHttpServer()
    rejecting.on('connect', (_request, socket) => socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'))
    const proxy = await listen(rejecting)
    let denied: unknown
    try { await undiciFetch('https://fixture.invalid/', { dispatcher: dispatcher(`http://127.0.0.1:${proxy.port}`, 1000, 'http') }) } catch (error) { denied = error }
    expect(denied).toBeDefined()
    expect(isProxyConnectFailure(denied)).toBe(false)
  })

  it('retains certificate validation on the HTTPS proxy itself', async () => {
    const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT })
    server.on('tlsClientError', () => {})
    const proxy = await listen(server)
    let rejected: unknown
    try { await undiciFetch('https://fixture.invalid/', { dispatcher: dispatcher(`https://127.0.0.1:${proxy.port}`, 1000, 'http') }) } catch (error) { rejected = error }
    expect(rejected).toBeDefined()
    expect(isProxyConnectFailure(rejected)).toBe(false)
  })

  it.each(['timeout', 'abort', 'destroy'] as const)('closes a SOCKS handshake socket on %s', async action => {
    const proxy = await socks({ stall: true })
    const route = dispatcher(proxy.url, action === 'timeout' ? 80 : 1000)
    const controller = new AbortController()
    const result = undiciFetch('http://fixture.invalid/', { dispatcher: route, signal: controller.signal }).then(() => null, error => error)
    await vi.waitFor(() => expect(proxy.sockets.size).toBe(1))
    if (action === 'abort') controller.abort()
    if (action === 'destroy') await route.destroy()
    expect(await result).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(proxy.sockets.size).toBe(0))
  })

  it.each(['abort', 'timeout'] as const)('releases one pending SOCKS handshake on %s without interrupting another active response in the same dispatcher', async action => {
    let emitted = 0
    const target = await listen(createHttpServer((request, response) => {
      if (request.url === '/after-cancel') { response.end('pool-still-usable'); return }
      response.writeHead(200, { 'content-type': 'video/x-flv' })
      response.write('first')
      const timer = setInterval(() => { emitted++; response.write('next') }, 10)
      response.once('close', () => clearInterval(timer))
    }))
    const proxy = await socks({ targetPort: target.port, stallFirst: true })
    const route = createProxyDispatcher({ kind: 'socks5', proxyUrl: proxy.url }, action === 'timeout' ? 250 : 5000, 2)
    owned.push(route)
    const controller = new AbortController()
    const blocked = undiciFetch('http://fixture.invalid/cancel', { dispatcher: route, signal: controller.signal }).then(() => null, error => error)
    await vi.waitFor(() => expect(proxy.sockets.size).toBe(1))
    const blockedSocket = [...proxy.sockets][0]!
    const response = await undiciFetch('http://fixture.invalid/live', { dispatcher: route })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    if (action === 'abort') controller.abort()
    expect(await blocked).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(proxy.sockets.has(blockedSocket)).toBe(false))
    const before = emitted
    await vi.waitFor(() => expect(emitted).toBeGreaterThan(before))
    expect((await reader.read()).done).toBe(false)
    expect(proxy.sockets.size).toBe(1)
    expect(await (await undiciFetch('http://fixture.invalid/after-cancel', { dispatcher: route })).text()).toBe('pool-still-usable')
    await reader.cancel()
  })

  it('supports WebSocket upgrades through SOCKS5', async () => {
    const target = createHttpServer()
    target.on('upgrade', (request, upgradeSocket) => {
      upgradeSocket.on('error', () => {})
      const key = request.headers['sec-websocket-key']!
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      upgradeSocket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      upgradeSocket.once('data', () => upgradeSocket.end())
    })
    const listener = await listen(target)
    const proxy = await socks({ targetPort: listener.port })
    const socket = new WebSocket('ws://fixture.invalid/', { dispatcher: dispatcher(proxy.url) })
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }) })
    expect(proxy.requests).toEqual([{ host: 'fixture.invalid', port: 80, type: 3 }])
    const closed = new Promise<void>(resolve => socket.addEventListener('close', () => resolve(), { once: true }))
    socket.close()
    await closed
  })

  it('does not classify a source socket drop after a POST was sent as a proxy connect failure', async () => {
    let received = false
    const target = await listen(createHttpServer(request => { request.on('data', () => {}); request.on('end', () => { received = true; request.socket.destroy() }) }))
    const proxy = await socks({ targetPort: target.port })
    let rejected: unknown
    try { await undiciFetch('http://fixture.invalid/', { dispatcher: dispatcher(proxy.url), method: 'POST', body: 'fixture' }) } catch (error) { rejected = error }
    expect(received).toBe(true)
    expect(isProxyConnectFailure(rejected)).toBe(false)
  })

  it('only recognizes trusted markers and lets certificate/authentication/status failures veto them', () => {
    expect(isProxyConnectFailure(Object.assign(new Error('proxy unreachable'), { code: 'ECONNREFUSED' }))).toBe(false)
    const marked = markProxyConnectFailure(Object.assign(new Error('代理无法连接.'), { code: 'ECONNREFUSED' }))
    expect(isProxyConnectFailure(new Error('request failed', { cause: marked }))).toBe(true)
    expect(isProxyConnectFailure(new AggregateError([marked], 'failed'))).toBe(true)
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UND_ERR_SOCKS5_AUTH_FAILED', 'UND_ERR_SOCKS5_REPLY_2']) {
      expect(isProxyConnectFailure(Object.assign(new Error('rejected', { cause: marked }), { code }))).toBe(false)
    }
    expect(isProxyConnectFailure(Object.assign(new Error('forbidden', { cause: marked }), { statusCode: 407 }))).toBe(false)
  })

  it('establishes concurrent HTTP CONNECT tunnels in parallel via a Pool instead of serializing behind one Client', async () => {
    const target = await listen(createHttpServer((request, response) => response.end(`ok:${request.url}`)))
    const pendingConnects: Array<() => void> = []
    const upstreams = new Set<Socket>()
    const server = createHttpServer()
    server.on('connect', (_request, socket, head) => {
      const complete = () => {
        const upstream = connect(target.port, '127.0.0.1')
        upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream))
        upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy())
        upstream.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) upstream.write(head)
          socket.pipe(upstream); upstream.pipe(socket)
        })
      }
      pendingConnects.push(complete)
      // Only finish the first CONNECT once the second CONNECT arrives concurrently.
      if (pendingConnects.length === 2) {
        for (const release of pendingConnects.splice(0)) release()
      }
    })
    const proxy = await listen(server)
    cleanup.push(async () => { for (const socket of upstreams) socket.destroy() })
    const route = createProxyDispatcher({ kind: 'http', proxyUrl: `http://127.0.0.1:${proxy.port}` }, 2_000, 2)
    owned.push(route)
    const results = await Promise.all([
      undiciFetch('http://first.fixture.invalid/a', { dispatcher: route }).then(r => r.text()),
      undiciFetch('http://second.fixture.invalid/b', { dispatcher: route }).then(r => r.text()),
    ])
    expect(results).toEqual(['ok:/a', 'ok:/b'])
  })

  it('keeps both HTTP and SOCKS5 proxy tunnels alive longer than Undici default 4s keep-alive timeout', async () => {
    expect(DEFAULT_PROXY_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(250)
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(500)
    const targetServer = createHttpServer((_request, response) => response.end('kept-alive'))
    // Disable Node's default 5s Keep-Alive header so Undici relies on the dispatcher's keepAliveTimeout.
    targetServer.keepAliveTimeout = 0
    const target = await listen(targetServer)
    const httpConnects: string[] = []
    const upstreams = new Set<Socket>()
    const httpServer = createHttpServer()
    httpServer.on('connect', (request, socket, head) => {
      httpConnects.push(request.url!)
      const upstream = connect(target.port, '127.0.0.1')
      upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream))
      upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy())
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream); upstream.pipe(socket)
      })
    })
    const httpProxy = await listen(httpServer)
    cleanup.push(async () => { for (const socket of upstreams) socket.destroy() })
    const socksProxy = await socks({ targetPort: target.port })
    const httpRoute = createProxyDispatcher({ kind: 'http', proxyUrl: `http://127.0.0.1:${httpProxy.port}` }, 0, 2)
    const socksRoute = createProxyDispatcher({ kind: 'socks5', proxyUrl: socksProxy.url }, 0, 2)
    owned.push(httpRoute, socksRoute)
    await Promise.all([
      undiciFetch('http://fixture.invalid/1', { dispatcher: httpRoute }).then(r => r.text()),
      undiciFetch('http://fixture.invalid/1', { dispatcher: socksRoute }).then(r => r.text()),
    ])
    // Wait past Undici's 4s default keepAliveTimeout; both HTTP and SOCKS5 tunnels must stay reused.
    await new Promise(resolve => setTimeout(resolve, 4_200))
    const second = await Promise.all([
      undiciFetch('http://fixture.invalid/2', { dispatcher: httpRoute }).then(r => r.text()),
      undiciFetch('http://fixture.invalid/2', { dispatcher: socksRoute }).then(r => r.text()),
    ])
    expect(second).toEqual(['kept-alive', 'kept-alive'])
    expect(httpConnects).toHaveLength(1)
    expect(socksProxy.requests).toHaveLength(1)
  }, 12_000)

  it('applies a bounded default connect/handshake deadline when requestTimeoutMs is 0 while allowing delayed response headers', async () => {
    const delayedTarget = await listen(createHttpServer((_request, response) => {
      setTimeout(() => response.end('slow-headers-ok'), 120)
    }))
    const socksProxy = await socks({ targetPort: delayedTarget.port })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const route = createProxyDispatcher({ kind: 'socks5', proxyUrl: socksProxy.url }, 0, 1)
      owned.push(route)
      const text = await (await undiciFetch('http://fixture.invalid/slow', { dispatcher: route })).text()
      expect(text).toBe('slow-headers-ok')
      const delays = setTimeoutSpy.mock.calls.map(call => call[1])
      expect(delays).toContain(DEFAULT_CONNECT_TIMEOUT_MS + 100)
    } finally { setTimeoutSpy.mockRestore() }
  })
})
