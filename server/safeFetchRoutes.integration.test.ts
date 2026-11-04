/** PAC routing and proxy failures through real loopback transports, never live accounts. */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { fetch as undiciFetch } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mediaRequestPolicy, type ProxyConfig } from './config'
import { NetworkPolicy } from './networkPolicy'
import { safeFetch } from './safeFetch'
import { TEST_TLS_CERT, TEST_TLS_KEY } from './networkTls.testFixture'

const releases: Array<() => Promise<void>> = []
const policy = mediaRequestPolicy({ enabled: true, hosts: [], allowNonStandardPorts: false, maxRedirects: 2, requestTimeoutMs: 1000 } satisfies ProxyConfig)
const fetchImpl = undiciFetch as unknown as typeof fetch
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

async function listen(server: Server) {
  const sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  releases.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { server, sockets, port: (server.address() as { port: number }).port }
}

async function refusedPort(): Promise<number> {
  const listener = await listen(createServer())
  await new Promise<void>(resolve => listener.server.close(() => resolve()))
  return listener.port
}

async function httpProxy(targetPort: number, behavior: 'tunnel' | '407' | 'stall' = 'tunnel') {
  const requests: string[] = []
  const upstreams = new Set<Socket>()
  const server = createHttpServer()
  server.on('connect', (request, socket, head) => {
    requests.push(request.url!)
    if (behavior === '407') { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return }
    // HTTP CONNECT sockets allow half-open connections. Observe the client FIN
    // and close the fixture's own write half instead of retaining it ourselves.
    if (behavior === 'stall') { socket.once('end', () => socket.end()); socket.resume(); return }
    const upstream = connect(targetPort, '127.0.0.1')
    upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream))
    upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy())
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
  })
  const listener = await listen(server)
  releases.push(async () => { for (const socket of upstreams) socket.destroy() })
  return { ...listener, requests, pac: `PROXY 127.0.0.1:${listener.port}` }
}

async function socksProxy(targetPort: number) {
  const requests: Array<{ host: string; port: number; addressType: number }> = []
  const upstreams = new Set<Socket>()
  const server = createServer(socket => {
    let greeting = true, buffered = Buffer.alloc(0)
    const data = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (greeting) {
        if (buffered.length < 2 || buffered.length < buffered[1]! + 2) return
        buffered = buffered.subarray(buffered[1]! + 2); greeting = false; socket.write(Buffer.from([5, 0])); return
      }
      if (buffered.length < 5) return
      const addressType = buffered[3]!, length = addressType === 3 ? buffered[4]! + 7 : addressType === 1 ? 10 : 22
      if (buffered.length < length) return
      const host = addressType === 3 ? buffered.subarray(5, length - 2).toString() : addressType === 1 ? [...buffered.subarray(4, 8)].join('.') : 'ipv6'
      requests.push({ host, port: buffered.readUInt16BE(length - 2), addressType })
      const remaining = buffered.subarray(length)
      socket.removeListener('data', data)
      const upstream = connect(targetPort, '127.0.0.1')
      upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream))
      upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy())
      upstream.once('connect', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
        if (remaining.length) upstream.write(remaining)
        socket.pipe(upstream); upstream.pipe(socket)
      })
    }
    socket.on('data', data)
  })
  const listener = await listen(server)
  releases.push(async () => { for (const socket of upstreams) socket.destroy() })
  return { ...listener, requests, pac: `SOCKS5 127.0.0.1:${listener.port}` }
}

function system(pac: string) {
  const resolveProxy = vi.fn(async () => pac)
  const network = new NetworkPolicy(resolveProxy, () => 'system').context('youtube')
  return { network, resolveProxy }
}

describe('safeFetch with ordered system proxy candidates', () => {
  it.each(['HTTP', 'SOCKS5'] as const)('moves from a refused first HTTP proxy to the declared second %s proxy', async kind => {
    let received = 0
    const target = await listen(createHttpServer((_request, response) => { received++; response.end('from-explicit-second-proxy') }))
    const second = kind === 'HTTP' ? await httpProxy(target.port) : await socksProxy(target.port)
    const firstPort = await refusedPort()
    const context = system(`PROXY 127.0.0.1:${firstPort}; ${second.pac}`)
    const resolve = vi.fn(async () => { throw new Error('target DNS must remain remote') })
    const url = `http://unresolvable.fixture.invalid:${target.port}/live?signature=PRIVATE`
    const result = await safeFetch(url, policy, { ...context, resolve, fetchImpl })
    expect(await result.response.text()).toBe('from-explicit-second-proxy')
    expect(received).toBe(1)
    expect(second.requests).toHaveLength(1)
    expect(context.resolveProxy).toHaveBeenCalledExactlyOnceWith(url)
    expect(resolve).not.toHaveBeenCalled()
    if (kind === 'SOCKS5') expect(second.requests[0]).toEqual({ host: 'unresolvable.fixture.invalid', port: target.port, addressType: 3 })
  })

  it('does not invent DIRECT when all declared proxies refuse connection', async () => {
    const received = vi.fn()
    const target = await listen(createHttpServer((_request, response) => { received(); response.end('must-not-be-direct') }))
    const firstPort = await refusedPort(), secondPort = await refusedPort()
    const context = system(`PROXY 127.0.0.1:${firstPort}; SOCKS5 127.0.0.1:${secondPort}`)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(`http://fixture.invalid:${target.port}/`, policy, { ...context, resolve, fetchImpl }))
      .rejects.toMatchObject({ failure: { stage: 'proxy', code: 'proxy-unreachable' } })
    expect(resolve).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
  })

  it('uses DIRECT only when the PAC list explicitly includes it after a refused proxy', async () => {
    const received = vi.fn()
    const target = await listen(createHttpServer((_request, response) => { received(); response.end('explicit-direct') }))
    const context = system(`PROXY 127.0.0.1:${await refusedPort()}; DIRECT`)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    const result = await safeFetch(`http://fixture.invalid:${target.port}/`, policy, { ...context, resolve, fetchImpl })
    expect(await result.response.text()).toBe('explicit-direct')
    expect(resolve).toHaveBeenCalledExactlyOnceWith('fixture.invalid')
    expect(received).toHaveBeenCalledOnce()
  })

  it('does not bypass a CONNECT 407 rejection with the later working proxy or DIRECT', async () => {
    const received = vi.fn()
    const target = await listen(createHttpServer((_request, response) => { received(); response.end('must-not-bypass') }))
    const first = await httpProxy(target.port, '407'), second = await httpProxy(target.port)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(`http://fixture.invalid:${target.port}/`, policy, {
      ...system(`${first.pac}; ${second.pac}; DIRECT`), resolve, fetchImpl,
    })).rejects.toMatchObject({ failure: { stage: 'proxy', code: 'proxy-rejected' } })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
  })

  it('does not switch routes after a source TLS certificate failure behind SOCKS5', async () => {
    const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT })
    server.on('tlsClientError', () => {})
    const target = await listen(server)
    const first = await socksProxy(target.port), second = await httpProxy(target.port)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(`https://fixture.invalid:${target.port}/?signature=PRIVATE`, policy, {
      ...system(`${first.pac}; ${second.pac}; DIRECT`), resolve, fetchImpl,
    })).rejects.toMatchObject({ failure: { stage: 'connect', code: 'tls-certificate' } })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not bypass a rejected HTTPS proxy certificate', async () => {
    const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT })
    server.on('tlsClientError', () => {})
    const first = await listen(server)
    const target = await listen(createHttpServer((_request, response) => response.end('must-not-bypass')))
    const second = await socksProxy(target.port)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(`http://fixture.invalid:${target.port}/`, policy, {
      ...system(`HTTPS 127.0.0.1:${first.port}; ${second.pac}; DIRECT`), resolve, fetchImpl,
    })).rejects.toMatchObject({ failure: { stage: 'connect', code: 'tls-certificate' } })
    expect(second.requests).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([403, 429, 503])('returns source HTTP %i without trying another proxy', async status => {
    let received = 0
    const target = await listen(createHttpServer((_request, response) => { received++; response.writeHead(status).end('source-error') }))
    const first = await httpProxy(target.port), second = await socksProxy(target.port)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    const result = await safeFetch(`http://fixture.invalid:${target.port}/`, policy, { ...system(`${first.pac}; ${second.pac}; DIRECT`), resolve, fetchImpl })
    expect(result.response.status).toBe(status)
    expect(await result.response.text()).toBe('source-error')
    expect(received).toBe(1)
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('never replays a POST when the source drops its socket after receiving the body', async () => {
    const bodies: string[] = []
    const target = await listen(createHttpServer(request => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => { bodies.push(body); request.socket.destroy() })
    }))
    const first = await httpProxy(target.port), second = await socksProxy(target.port)
    const resolve = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(`http://fixture.invalid:${target.port}/`, policy, {
      ...system(`${first.pac}; ${second.pac}; DIRECT`), resolve, fetchImpl, method: 'POST', body: 'fixture-once',
    })).rejects.toMatchObject({ failure: { stage: 'proxy' } })
    expect(bodies).toEqual(['fixture-once'])
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('bounds a stalled CONNECT handshake without silently trying DIRECT', async () => {
    const received = vi.fn()
    const target = await listen(createHttpServer((_request, response) => { received(); response.end('must-not-bypass') }))
    const first = await httpProxy(target.port, 'stall')
    const resolve = vi.fn(async () => ['127.0.0.1'])
    let rejected: unknown
    try {
      await safeFetch(`http://fixture.invalid:${target.port}/?signature=PRIVATE`, { ...policy, requestTimeoutMs: 60 }, {
        ...system(`${first.pac}; DIRECT`), resolve, fetchImpl, signal: AbortSignal.timeout(2000),
      })
    } catch (error) { rejected = error }
    expect(rejected).toMatchObject({ failure: { stage: 'proxy', code: 'proxy-unreachable', message: '代理握手超时, 请检查系统代理.' } })
    expect(JSON.stringify(rejected)).not.toMatch(/PRIVATE|fixture\.invalid|127\.0\.0\.1/)
    expect(first.requests).toHaveLength(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(first.sockets.size).toBe(0))
  })

  it('validates Fake-IP snapshots with a stubbed transport instead of contacting 198.18/15', async () => {
    const addresses = ['198.18.0.1', '198.19.255.254']
    const resolve = vi.fn(async () => addresses)
    const fetchStub = vi.fn(async () => new Response('fake-ip-policy-only')) as unknown as typeof fetch
    const result = await safeFetch('http://fake.fixture.invalid:32123/live', policy, { ...system('DIRECT'), resolve, fetchImpl: fetchStub })
    expect(await result.response.text()).toBe('fake-ip-policy-only')
    expect(resolve).toHaveBeenCalledExactlyOnceWith('fake.fixture.invalid')
    expect(fetchStub).toHaveBeenCalledOnce()
    expect(addresses).toEqual(['198.18.0.1', '198.19.255.254'])
  })
})
