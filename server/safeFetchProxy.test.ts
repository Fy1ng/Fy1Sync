import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fetch as undiciFetch } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProxyConfig } from './config'
import { directNetwork, type NetworkContext } from './networkPolicy'
import { classifyNetworkFailure } from './networkFailure'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'
import { TEST_TLS_CERT, TEST_TLS_KEY } from './networkTls.testFixture'

const policy: ProxyConfig = { enabled: true, hosts: ['fixture.invalid', 'cdn.fixture.invalid'],
  allowNonStandardPorts: false, maxRedirects: 3, requestTimeoutMs: 3000 }
const proxy: NetworkContext = { route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }) }
const responses = (...values: Response[]) => vi.fn(async () => values.shift()!) as unknown as typeof fetch
const releases: (() => Promise<void>)[] = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as { port: number }).port
}
async function tunnel(target: Server) {
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  target.on('connection', track)
  const targetPort = await listen(target)
  const requests: string[] = []
  const relay = createServer()
  relay.on('connection', track)
  relay.on('connect', (request, socket, head) => {
    requests.push(request.url!)
    const outgoing = connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) outgoing.write(head)
      socket.pipe(outgoing).pipe(socket)
    })
    track(outgoing)
    outgoing.on('error', () => socket.destroy())
    socket.on('error', () => outgoing.destroy())
  })
  const relayPort = await listen(relay)
  releases.push(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([relay, target].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })))
  })
  return { requests, sockets, targetPort, network: { route: async () => ({ kind: 'http' as const, proxyUrl: `http://127.0.0.1:${relayPort}` }) } }
}

/** Trust only this synthetic certificate in a child; production TLS verification stays enabled. */
async function trustedTlsRequest(url: string, route: { kind: 'direct' | 'http'; proxyUrl?: string }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fy1sync-test-tls-'))
  const certificate = path.join(directory, 'synthetic-ca.pem')
  await writeFile(certificate, TEST_TLS_CERT, { flag: 'wx' })
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: certificate }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  const source = `
    import { runnerImport } from 'vite'
    const { module } = await runnerImport(process.argv[1], { configFile: false, logLevel: 'silent' })
    const config = JSON.parse(process.argv[3]), route = JSON.parse(process.argv[4])
    try {
      const result = await module.safeFetch(process.argv[2], config, {
        network: { route: async () => route }, resolve: async () => ['127.0.0.1']
      })
      process.stdout.write(JSON.stringify({ status: result.response.status, body: await result.response.text() }))
    } catch (error) {
      process.stderr.write(JSON.stringify({ code: error?.failure?.code ?? error?.code ?? 'fixture-failed' }))
      process.exitCode = 1
    }
  `
  try {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source,
      fileURLToPath(new URL('./safeFetch.ts', import.meta.url)), url,
      JSON.stringify({ ...policy, allowNonStandardPorts: true }), JSON.stringify(route)],
    { env, windowsHide: true, timeout: 15_000, maxBuffer: 1_048_576 })
    return JSON.parse(result.stdout) as { status: number; body: string }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('safeFetch trusted proxy branch', () => {
  it('does not query local target DNS while using a proxy', async () => {
    const dns = vi.fn(async () => ['10.0.0.1'])
    const fetchImpl = responses(new Response('fixture'))
    const result = await safeFetch('https://fixture.invalid/live?fixture=1', policy, { resolve: dns, network: proxy, fetchImpl })
    expect(await result.response.text()).toBe('fixture')
    expect(dns).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['https://outside.invalid/live', 'host-not-allowed'],
    ['ftp://fixture.invalid/live', 'bad-scheme'],
    ['https://fixture.invalid:8443/live', 'bad-port'],
    ['https://fixture-user:fixture-pass@fixture.invalid/live', 'invalid-url'],
  ])('rejects unsafe target %s before connecting', async (url, reason) => {
    const fetchImpl = responses(new Response('must not connect'))
    const dns = vi.fn(async () => ['127.0.0.1'])
    await expect(safeFetch(url, policy, { network: proxy, resolve: dns, fetchImpl })).rejects.toMatchObject({ reason })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(dns).not.toHaveBeenCalled()
  })

  it('evaluates the route again after a redirect and restores DNS pinning when PAC selects DIRECT', async () => {
    const route = vi.fn(async url => url.includes('cdn.fixture.invalid') ? { kind: 'direct' as const }
      : { kind: 'http' as const, proxyUrl: 'http://127.0.0.1:3128' })
    const dns = vi.fn(async () => ['93.184.216.34'])
    const fetchImpl = responses(new Response(null, { status: 302, headers: { location: 'https://cdn.fixture.invalid/live' } }), new Response('media'))
    const result = await safeFetch('https://fixture.invalid/entry', policy, { network: { route }, resolve: dns, fetchImpl })
    expect(await result.response.text()).toBe('media')
    expect(route.mock.calls.map(call => call[0])).toEqual(['https://fixture.invalid/entry', 'https://cdn.fixture.invalid/live'])
    expect(dns.mock.calls).toEqual([['cdn.fixture.invalid']])
  })

  it.each([
    ['https://outside.invalid/redirect', 'host-not-allowed'],
    ['https://fixture-user:fixture-pass@fixture.invalid/live', 'invalid-url'],
    ['file:///private/secret', 'bad-scheme'],
    ['https://fixture.invalid:8443/private', 'bad-port'],
  ])('revalidates every redirected target %s', async (location, reason) => {
    const fetchImpl = responses(new Response(null, { status: 302, headers: { location } }))
    await expect(safeFetch('https://fixture.invalid/start', policy, { network: proxy, fetchImpl })).rejects.toMatchObject({ reason })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['Cookie', 'Authorization', 'Proxy-Authorization'])('refuses cross-origin redirects carrying %s', async name => {
    const fetchImpl = responses(new Response(null, { status: 302, headers: { location: 'https://cdn.fixture.invalid/live' } }))
    await expect(safeFetch('https://fixture.invalid/start', policy, { network: proxy, fetchImpl,
      headers: { [name]: 'fixture-credential' } })).rejects.toMatchObject({ reason: 'cross-origin-credentials' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('continues same-origin credential redirects through fresh per-URL route decisions', async () => {
    const route = vi.fn(proxy.route)
    const fetchImpl = responses(new Response(null, { status: 302, headers: { location: '/next' } }), new Response('same-origin'))
    expect(await (await safeFetch('https://fixture.invalid/start', policy, { network: { route }, fetchImpl,
      headers: { Cookie: 'fixture-credential' } })).response.text()).toBe('same-origin')
    expect(route).toHaveBeenCalledTimes(2)
  })

  it('rejects invalid direct DNS answers before connecting', async () => {
    const dns = vi.fn(async () => ['not-an-ip'])
    const fetchImpl = responses(new Response('must not connect'))
    await expect(safeFetch('https://fixture.invalid/live', policy, { network: directNetwork, resolve: dns, fetchImpl }))
      .rejects.toMatchObject({ reason: 'dns-failed' })
    expect(dns).toHaveBeenCalledWith('fixture.invalid')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('includes proxy endpoint and credentials in connection pool ownership', async () => {
    const pool = new PinnedDispatcherPool()
    const url = new URL('https://fixture.invalid/live')
    try {
      const a = pool.get(url, [], 3000, { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' })
      expect(pool.get(url, [], 3000, { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' })).toBe(a)
      expect(pool.get(url, [], 3000, { kind: 'http', proxyUrl: 'http://127.0.0.1:8080' })).not.toBe(a)
      expect(pool.get(url, [], 3000, { kind: 'http', proxyUrl: 'http://fixture:credential@127.0.0.1:3128' })).not.toBe(a)
      expect(pool.get(url, ['93.184.216.34'], 3000, { kind: 'direct' })).not.toBe(a)
    } finally { await pool.dispose() }
  })

  it('sends a real Node HTTP request through a local CONNECT proxy without resolving its target locally', async () => {
    const target = createServer((request, response) => { response.end(`fixture:${request.url}`) })
    const relay = await tunnel(target)
    const dns = vi.fn(async () => { throw new Error('local DNS must not run') })
    const result = await safeFetch('http://fixture.invalid/live?fixture=1', policy, { network: relay.network,
      resolve: dns, fetchImpl: undiciFetch as unknown as typeof fetch })
    expect(await result.response.text()).toBe('fixture:/live?fixture=1')
    expect(relay.requests).toEqual(['fixture.invalid:80'])
    expect(dns).not.toHaveBeenCalled()
  })

  it('rejects a real self-signed TLS certificate behind a local CONNECT proxy without external tools', async () => {
    const target = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_request, response) => response.end('must not trust this fixture'))
    target.on('tlsClientError', () => {})
    const relay = await tunnel(target)
    const dns = vi.fn(async () => { throw new Error('local DNS must not run') })
    await expect(safeFetch('https://fixture.invalid/live?signature=PRIVATE', policy, { network: relay.network, resolve: dns,
      fetchImpl: undiciFetch as unknown as typeof fetch })).rejects.toMatchObject({ failure: { stage: 'connect', code: 'tls-certificate' } })
    expect(relay.requests).toEqual(['fixture.invalid:443'])
    expect(dns).not.toHaveBeenCalled()
  })

  it.each(['direct', 'http'] as const)('verifies a trusted synthetic HTTPS certificate on a non-standard target port via %s', async kind => {
    const hosts: Array<string | undefined> = []
    const target = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (request, response) => {
      hosts.push(request.headers.host)
      response.end('verified-local-tls')
    })
    target.on('tlsClientError', () => {})
    let targetPort: number, route: { kind: 'direct' | 'http'; proxyUrl?: string }
    let authorities: string[] | undefined
    if (kind === 'http') {
      const relay = await tunnel(target)
      targetPort = relay.targetPort
      route = await relay.network.route()
      authorities = relay.requests
    } else {
      targetPort = await listen(target)
      route = { kind: 'direct' }
      releases.push(() => new Promise<void>(resolve => { target.close(() => resolve()); target.closeAllConnections() }))
    }
    const url = `https://fixture.invalid:${targetPort}/live?signature=PRIVATE`
    expect(await trustedTlsRequest(url, route)).toEqual({ status: 200, body: 'verified-local-tls' })
    expect(hosts).toEqual([`fixture.invalid:${targetPort}`])
    if (authorities) expect(authorities).toEqual([`fixture.invalid:${targetPort}`])
  }, 20_000)

  it.each(['direct', 'http'] as const)('retains real certificate verification on a non-standard HTTPS target via %s', async kind => {
    const handled = vi.fn()
    const target = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, handled)
    target.on('tlsClientError', () => {})
    let targetPort: number, network: NetworkContext
    if (kind === 'http') {
      const relay = await tunnel(target)
      targetPort = relay.targetPort
      network = relay.network
    } else {
      targetPort = await listen(target)
      network = directNetwork
      releases.push(() => new Promise<void>(resolve => { target.close(() => resolve()); target.closeAllConnections() }))
    }
    const operation = safeFetch(`https://fixture.invalid:${targetPort}/live?signature=PRIVATE`,
      { ...policy, allowNonStandardPorts: true }, { network, resolve: async () => ['127.0.0.1'] })
    const failure = await operation.then(() => null, error => classifyNetworkFailure(error))
    expect(failure).toMatchObject({ stage: 'connect', code: 'tls-certificate' })
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|signature|https?:\/\//)
    expect(handled).not.toHaveBeenCalled()
  })

  it('cancels an actual CONNECT media stream and closes both sides of the tunnel', async () => {
    const closed = vi.fn()
    const target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp2t' }).write('first')
      response.once('close', closed)
    })
    const relay = await tunnel(target)
    const controller = new AbortController()
    const result = await safeFetch('http://fixture.invalid/live', policy, {
      network: relay.network, signal: controller.signal, resolve: async () => { throw new Error('Proxy owns target DNS') },
    })
    const reader = result.response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(relay.sockets.size).toBe(0))
  })

  it('uses real CONNECT and DIRECT sockets for a redirected URL whose route changes', async () => {
    const destination = createServer((_request, response) => response.end('direct-after-connect'))
    const destinationPort = await listen(destination)
    releases.push(() => new Promise<void>(resolve => { destination.close(() => resolve()); destination.closeAllConnections() }))
    const first = createServer((_request, response) => response.writeHead(302, { location: `http://cdn.fixture.invalid:${destinationPort}/final` }).end())
    const relay = await tunnel(first)
    const route = vi.fn(async (url: string) => url.includes('cdn.fixture.invalid') ? { kind: 'direct' as const } : relay.network.route())
    const dns = vi.fn(async () => ['127.0.0.1'])
    const result = await safeFetch(`http://fixture.invalid:${relay.targetPort}/start`, { ...policy, allowNonStandardPorts: true }, {
      network: { route }, resolve: dns,
    })
    expect(await result.response.text()).toBe('direct-after-connect')
    expect(relay.requests).toEqual([`fixture.invalid:${relay.targetPort}`])
    expect(route.mock.calls.map(call => call[0])).toEqual([
      `http://fixture.invalid:${relay.targetPort}/start`, `http://cdn.fixture.invalid:${destinationPort}/final`,
    ])
    expect(dns.mock.calls).toEqual([['cdn.fixture.invalid']])
  })
})
