import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, mediaRequestPolicy } from './config'
import { DEFAULT_MEDIA_NETWORK, validMediaNetwork, type MediaNetworkOptions } from './mediaNetworkOptions'
import { NetworkPolicy, type NetworkContext } from './networkPolicy'
import { mediaChild, mediaEntry } from './mediaAccess'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'
import { TEST_TLS_CERT, TEST_TLS_KEY } from './networkTls.testFixture'

const config = resolveConfig({}).proxy
const servers: Server[] = []
const peers = new Set<Socket>()
const track = (socket: Socket) => { peers.add(socket); socket.once('close', () => peers.delete(socket)) }
async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', track)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as { port: number }).port
}
const context = (options: Partial<MediaNetworkOptions> = {}): NetworkContext => ({
  route: async () => ({ kind: 'direct' }), media: { ...DEFAULT_MEDIA_NETWORK, ...options },
})
afterEach(async () => {
  for (const peer of peers) peer.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('user-owned playback networking', () => {
  it('disables the old request deadline by default and honors an explicitly configured deadline', async () => {
    const port = await listen(createServer((_request, response) => { setTimeout(() => response.end('late video'), 50) }))
    const url = `http://127.0.0.1:${port}/live.mp4`
    const result = await safeFetch(url, mediaRequestPolicy({ ...config, requestTimeoutMs: 5 }), { network: context() })
    expect(await result.response.text()).toBe('late video')
    await expect(safeFetch(url, mediaRequestPolicy(config), { network: context({ requestTimeoutMs: 5 }) })).rejects.toThrow()
  })
  it('accepts a real self-signed and hostname-mismatched media certificate without relaxing service requests', async () => {
    const port = await listen(createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_request, response) => response.end('video')))
    const url = `https://different.invalid:${port}/live.mp4`
    const options = { resolve: async () => ['127.0.0.1'], signal: AbortSignal.timeout(3000) }
    const result = await safeFetch(url, mediaRequestPolicy(config), { ...options, network: context() })
    expect(await result.response.text()).toBe('video')
    await expect(safeFetch(url, mediaRequestPolicy(config), { ...options, network: context({ verifyTls: true }) })).rejects.toThrow()
    await expect(safeFetch(url, { ...config, hosts: ['different.invalid'], allowNonStandardPorts: true }, options)).rejects.toThrow()
  })

  it.each(['Cookie', 'Authorization'])('keeps %s requests verified and isolates their pooled sockets from anonymous playback', async name => {
    let hits = 0
    const port = await listen(createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_request, response) => { hits++; response.end('video') }))
    const pool = new PinnedDispatcherPool()
    const options = { resolve: async () => ['127.0.0.1'], signal: AbortSignal.timeout(3000), network: context(), dispatcherPool: pool }
    const url = `https://fixture.invalid:${port}/live.mp4`
    try {
      const result = await safeFetch(url, mediaRequestPolicy(config), options)
      await result.response.text()
      await expect(safeFetch(url, mediaRequestPolicy(config), { ...options, headers: { [name]: 'synthetic' } })).rejects.toThrow()
      expect(hits).toBe(1)
    } finally { await pool.dispose() }
  })

  it('controls HTTPS proxy and destination certificates separately across a real CONNECT tunnel', async () => {
    const targetPort = await listen(createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_request, response) => response.end('tunneled')))
    const proxy = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT })
    proxy.on('connect', (_request, socket, head) => {
      const outgoing = connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) outgoing.write(head)
        socket.pipe(outgoing).pipe(socket)
      })
      track(outgoing)
      outgoing.on('error', () => socket.destroy())
      socket.on('error', () => outgoing.destroy())
    })
    const proxyPort = await listen(proxy)
    const network = { ...context(), route: async () => ({ kind: 'http' as const, proxyUrl: `https://127.0.0.1:${proxyPort}` }) }
    const url = `https://fixture.invalid:${targetPort}/live.mp4`
    const result = await safeFetch(url, mediaRequestPolicy(config), { network, signal: AbortSignal.timeout(3000) })
    expect(await result.response.text()).toBe('tunneled')
    for (const strict of [{ verifyProxyTls: true }, { verifyTls: true }]) {
      await expect(safeFetch(url, mediaRequestPolicy(config), {
        network: { ...network, media: { ...DEFAULT_MEDIA_NETWORK, ...strict } }, signal: AbortSignal.timeout(3000),
      })).rejects.toThrow()
    }
  })

  it('allows arbitrary media domains, ports, private redirects and child resources while keeping an optional private boundary', async () => {
    const access = mediaEntry('https://public.invalid/master.m3u8')
    const fetchImpl = vi.fn(async () => new Response('segment')) as typeof fetch
    const options = { network: context(), mediaAccess: mediaChild(access), resolve: async () => ['127.0.0.1'], fetchImpl }
    const result = await safeFetch('http://other.internal:9123/segment.ts', mediaRequestPolicy(config), options)
    expect(await result.response.text()).toBe('segment')
    await expect(safeFetch('http://other.internal:9123/segment.ts', mediaRequestPolicy(config), {
      ...options, network: context({ allowPrivate: false }),
    })).rejects.toMatchObject({ reason: 'media-network-boundary' })
    expect((await safeFetch('https://outside.invalid/api', config, options)).response.status).toBe(200)
    await expect(safeFetch('https://outside.invalid/api', config, { ...options, network: { route: context().route } })).rejects.toMatchObject({ reason: 'host-not-allowed' })
  })

  it('removes the old redirect ceiling, detects loops, supports a user ceiling and still refuses credential forwarding', async () => {
    const fetchImpl = vi.fn(async input => {
      const url = new URL(String(input)), step = Number(url.pathname.slice(1))
      return step < 12 ? new Response(null, { status: 302, headers: { location: `http://fixture.internal:9210/${step + 1}` } }) : new Response('done')
    }) as typeof fetch
    const options = { network: context(), resolve: async () => ['127.0.0.1'], fetchImpl }
    expect(await (await safeFetch('http://fixture.internal:9210/0', mediaRequestPolicy(config), options)).response.text()).toBe('done')
    await expect(safeFetch('http://fixture.internal:9210/0', mediaRequestPolicy(config), { ...options, network: context({ maxRedirects: 2 }) }))
      .rejects.toMatchObject({ reason: 'too-many-redirects' })
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'http://other.internal/loop' } })
    await expect(safeFetch('http://other.internal/loop', mediaRequestPolicy(config), { ...options, fetchImpl: redirect }))
      .rejects.toMatchObject({ reason: 'too-many-redirects' })
    await expect(safeFetch('http://fixture.internal/start', mediaRequestPolicy(config), { ...options, network: { route: context().route }, fetchImpl: redirect, headers: { Cookie: 'synthetic=1' } }))
      .rejects.toMatchObject({ reason: 'cross-origin-credentials' })
  })

  it('freezes playback preferences and permits explicit direct, system and custom routes without changing service routing', async () => {
    let options = { ...DEFAULT_MEDIA_NETWORK }
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:7890')
    const policy = new NetworkPolicy(resolve, () => 'direct', Date.now, 15000, undefined, () => options)
    const old = policy.mediaContext('twitch')
    expect(old.media).toEqual(DEFAULT_MEDIA_NETWORK)
    expect(policy.context('twitch').media).toBeUndefined()
    options = { ...options, routing: 'direct', verifyTls: true }
    expect(await policy.mediaContext('twitch').route('https://gql.twitch.tv/')).toEqual({ kind: 'direct' })
    expect(await old.route('https://gql.twitch.tv/')).toMatchObject({ kind: 'http' })
    expect(old.media?.verifyTls).toBe(false)
    options = { ...options, routing: 'system' }
    expect(await policy.mediaContext('douyu').route('https://www.douyu.com/')).toMatchObject({ kind: 'http' })
    expect(await policy.context('douyu').route('https://www.douyu.com/')).toEqual({ kind: 'direct' })
    options = { ...options, routing: 'custom', proxyUrl: 'socks5://127.0.0.1', fallbackDirect: true }
    expect(await policy.mediaContext('twitch').route('https://gql.twitch.tv/')).toMatchObject({ kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080', alternatives: [{ kind: 'direct' }] })
  })

  it('falls back from failed proxy discovery only when the user enabled direct fallback', async () => {
    let options = { ...DEFAULT_MEDIA_NETWORK }
    const policy = new NetworkPolicy(async () => { throw new Error('fixture') }, () => 'system', Date.now, 15000, undefined, () => options)
    await expect(policy.mediaContext('twitch').route('https://gql.twitch.tv/')).rejects.toThrow()
    options = { ...options, fallbackDirect: true }
    expect(await policy.mediaContext('twitch').route('https://gql.twitch.tv/')).toEqual({ kind: 'direct' })
  })

  it('validates executable transport capabilities and timer ranges without accepting foreign fields', () => {
    expect(validMediaNetwork(DEFAULT_MEDIA_NETWORK)).toBe(true)
    for (const patch of [{ routing: 'custom' }, { proxyUrl: 'file:///tmp/proxy' }, { verifyTls: 'false' },
      { requestTimeoutMs: -1 }, { startupTimeoutMs: 2_147_483_648 }, { maxRedirects: NaN }, { host: '*' }]) {
      expect(validMediaNetwork({ ...DEFAULT_MEDIA_NETWORK, ...patch })).toBe(false)
    }
  })
})
