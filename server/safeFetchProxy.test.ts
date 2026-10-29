import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import path from 'node:path'
import { fetch as undiciFetch } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProxyConfig } from './config'
import { directNetwork, type NetworkContext } from './networkPolicy'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'

const policy: ProxyConfig = { enabled: true, hosts: ['fixture.invalid', 'cdn.fixture.invalid'],
  allowNonStandardPorts: false, allowNonLoopbackTargets: false, maxRedirects: 3, requestTimeoutMs: 3000 }
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
  return { requests, network: { route: async () => ({ kind: 'http' as const, proxyUrl: `http://127.0.0.1:${relayPort}` }) } }
}

describe('safeFetch trusted proxy branch', () => {
  it('does not query local DNS or apply direct-path private address rejection while using a proxy', async () => {
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
      headers: { [name]: 'fixture-credential' } })).rejects.toMatchObject({ reason: 'upstream-failed' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('continues same-origin credential redirects through fresh per-URL route decisions', async () => {
    const route = vi.fn(proxy.route)
    const fetchImpl = responses(new Response(null, { status: 302, headers: { location: '/next' } }), new Response('same-origin'))
    expect(await (await safeFetch('https://fixture.invalid/start', policy, { network: { route }, fetchImpl,
      headers: { Cookie: 'fixture-credential' } })).response.text()).toBe('same-origin')
    expect(route).toHaveBeenCalledTimes(2)
  })

  it('keeps the existing direct DNS/private target boundary unchanged', async () => {
    const dns = vi.fn(async () => ['10.0.0.1'])
    const fetchImpl = responses(new Response('must not connect'))
    await expect(safeFetch('https://fixture.invalid/live', policy, { network: directNetwork, resolve: dns, fetchImpl }))
      .rejects.toMatchObject({ reason: 'private-address' })
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

  const opensslAvailable = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore', windowsHide: true }); return true } catch { return false } })()
  it.skipIf(!opensslAvailable)('rejects a real self-signed TLS certificate behind a local CONNECT proxy', async () => {
    const root = path.resolve('.runtime-cache/codex-network-impl-20261030-implementation')
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(path.join(root, 'proxy-tls-'))
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.invalid',
      '-addext', 'subjectAltName=DNS:fixture.invalid', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')],
    { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
    const [key, cert] = await Promise.all([readFile(path.join(directory, 'key.pem')), readFile(path.join(directory, 'cert.pem'))])
    const target = createHttpsServer({ key, cert }, (_request, response) => response.end('must not trust this fixture'))
    target.on('tlsClientError', () => {})
    const relay = await tunnel(target)
    const dns = vi.fn(async () => { throw new Error('local DNS must not run') })
    await expect(safeFetch('https://fixture.invalid/live?signature=PRIVATE', policy, { network: relay.network, resolve: dns,
      fetchImpl: undiciFetch as unknown as typeof fetch })).rejects.toMatchObject({ failure: { stage: 'connect', code: 'tls-certificate' } })
    expect(relay.requests).toEqual(['fixture.invalid:443'])
    expect(dns).not.toHaveBeenCalled()
  }, 15_000)
})
