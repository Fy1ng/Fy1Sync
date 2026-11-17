import { createServer as createHttpsServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, mediaRequestPolicy } from './config'
import { DEFAULT_MEDIA_NETWORK, validMediaNetwork, type MediaSourceRule } from './mediaNetworkOptions'
import type { NetworkContext } from './networkPolicy'
import { safeFetch } from './safeFetch'
import { MediaRegistry } from './mediaProxy'
import { resolveStream } from './platforms'
import { probeMediaKind } from './mediaProbe'
import { TEST_TLS_KEY, TEST_TLS_CERT } from './networkTls.testFixture'

const config = resolveConfig({}).proxy
const owner = (): NetworkContext & { controller: AbortController } => {
  const controller = new AbortController()
  return { controller, signal: controller.signal, media: { ...DEFAULT_MEDIA_NETWORK }, route: async () => ({ kind: 'direct' }) }
}
const servers: Server[] = []
const peers = new Set<Socket>()
afterEach(async () => {
  for (const peer of peers) peer.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('playback origin policy and user credentials', () => {
  it('strips inherited credentials across origins and applies only the destination user rule', async () => {
    const network = owner()
    network.media = { ...DEFAULT_MEDIA_NETWORK, sourceRules: [
      { origin: 'https://second.invalid:8443', headers: { Authorization: 'Bearer second-user-token', Referer: 'https://second.invalid/' }, verifyTls: false, verifyProxyTls: false },
    ] }
    const requests: { url: string; headers: Headers; method?: string; body?: BodyInit | null }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method, body: init?.body })
      return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://second.invalid:8443/media' } }) : new Response('video')
    }
    const result = await safeFetch('https://first.invalid/start', mediaRequestPolicy(config), {
      network, resolve: async () => ['8.8.8.8'], fetchImpl,
      headers: { Cookie: 'account=first-only', Authorization: 'Bearer first-token', 'X-Auth-Token': 'first-private', 'User-Agent': 'UserPlayer' },
    })
    expect(await result.response.text()).toBe('video')
    expect(requests[0]!.headers.get('Cookie')).toBe('account=first-only')
    expect(requests[1]!.headers.get('Cookie')).toBeNull()
    expect(requests[1]!.headers.get('X-Auth-Token')).toBeNull()
    expect(requests[1]!.headers.get('Authorization')).toBe('Bearer second-user-token')
    expect(requests[1]!.headers.get('User-Agent')).toBe('UserPlayer')
  })

  it('uses HTTP redirect method semantics and never replays an account-bearing body to another origin', async () => {
    const requests: RequestInit[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(init!)
      return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://second.invalid/data' } }) : new Response('done')
    }
    await safeFetch('https://first.invalid/query', mediaRequestPolicy(config), { network: owner(), resolve: async () => ['8.8.8.8'], fetchImpl,
      method: 'POST', body: 'private-body', headers: { Cookie: 'account=synthetic', 'Content-Type': 'application/json' } })
    expect(requests[1]!.method).toBe('GET')
    expect(requests[1]!.body).toBeUndefined()
    expect(new Headers(requests[1]!.headers).get('Cookie')).toBeNull()
    expect(new Headers(requests[1]!.headers).get('Content-Type')).toBeNull()
    await expect(safeFetch('https://first.invalid/query', mediaRequestPolicy(config), {
      network: owner(), resolve: async () => ['8.8.8.8'], method: 'POST', body: 'private-body', headers: { Cookie: 'account=synthetic' },
      fetchImpl: async () => new Response(null, { status: 307, headers: { Location: 'https://second.invalid/data' } }),
    })).rejects.toMatchObject({ reason: 'cross-origin-credentials' })
  })

  it('converts URL credentials to origin-bound Basic authentication and returns a clean public media URL', async () => {
    const network = owner()
    const requests: { url: string; authorization: string | null }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') })
      return requests.length === 1 ? new Response(null, { status: 302, headers: { Location: 'http://other.invalid/video' } }) : new Response('video')
    }
    await safeFetch('http://test-user:p%3Assword@media.invalid/video', mediaRequestPolicy(config), { network, resolve: async () => ['8.8.8.8'], fetchImpl })
    expect(requests).toEqual([
      { url: 'http://media.invalid/video', authorization: `Basic ${Buffer.from('test-user:p:ssword').toString('base64')}` },
      { url: 'http://other.invalid/video', authorization: null },
    ])
    const result = await resolveStream('http://test-user:p%3Assword@media.invalid/video', {} as never)
    expect(result).toMatchObject({ ok: true, stream: { url: 'http://media.invalid/video', headers: { Authorization: expect.any(String) } } })
  })

  it('allows an explicitly trusted credentialed source with a self-signed certificate while keeping other sources strict', async () => {
    const credentials: (string | undefined)[] = []
    const server = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (request, response) => {
      credentials.push(request.headers.authorization); response.end('trusted by user')
    })
    servers.push(server)
    server.on('connection', peer => { peers.add(peer); peer.once('close', () => peers.delete(peer)) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const network = owner()
    const rule: MediaSourceRule = { origin: `https://fixture.invalid:${port}`, headers: { Authorization: 'Bearer user-selected' }, verifyTls: false, verifyProxyTls: false }
    network.media = { ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] }
    const options = { network, resolve: async () => ['127.0.0.1'], signal: AbortSignal.timeout(3000) }
    const result = await safeFetch(`${rule.origin}/video`, config, options)
    expect(await result.response.text()).toBe('trusted by user')
    expect(credentials).toEqual(['Bearer user-selected'])
    await expect(safeFetch(`https://other.invalid:${port}/video`, mediaRequestPolicy(config), {
      ...options, headers: { Cookie: 'automatic-account=synthetic' },
    })).rejects.toThrow()
    expect(credentials).toHaveLength(1)
  })

  it('sniffs an extensionless playlist, accepts binary media and cancels the probe response', async () => {
    for (const [body, kind] of [['#EXTM3U\n#EXTINF:2,\na.ts\n', 'hls'], ['binary-video', 'progressive']] as const) {
      const cancel = vi.fn()
      const bytes = Buffer.from(body)
      const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes) }, cancel }))
      expect(await probeMediaKind('http://127.0.0.1:9120/play?signature=synthetic', undefined, config, owner(), fetchImpl)).toBe(kind)
      expect(cancel).toHaveBeenCalledOnce()
    }
  })

  it('rejects header injection and duplicate origin rules while accepting old saved settings', () => {
    const rule: MediaSourceRule = { origin: 'https://media.invalid', headers: { Authorization: 'user-value' }, verifyTls: false, verifyProxyTls: false }
    expect(validMediaNetwork({ ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule] })).toBe(true)
    expect(validMediaNetwork({ ...DEFAULT_MEDIA_NETWORK, sourceRules: [rule, rule] })).toBe(false)
    expect(validMediaNetwork({ ...DEFAULT_MEDIA_NETWORK, sourceRules: [{ ...rule, headers: { Authorization: 'token\r\nInjected: value' } }] })).toBe(false)
    const legacy = { ...DEFAULT_MEDIA_NETWORK }; delete legacy.sourceRules; delete legacy.maxExtraStreams
    expect(validMediaNetwork(legacy)).toBe(true)
  })
})

describe('referenced media capability lifetime', () => {
  it('retains live roots and current children through time and capacity pressure, releases stale children and closes with the owner', async () => {
    let now = 0, revision = 'a'
    const network = owner()
    const registry = new MediaRegistry({ config, now: () => now, maxResources: 4, resolve: async () => ['8.8.8.8'], fetchImpl: async input =>
      String(input).includes('master') ? new Response(`#EXTM3U\n#EXTINF:2,\nhttps://child.invalid/${revision}.ts\n`) : new Response('video') })
    try {
      const root = registry.register('https://media.invalid/master', { Cookie: 'root-only=synthetic' }, network)
      const initial = await (await registry.handle(new Request(root))).text()
      const child = initial.match(/app:\/\/app\/media\/[a-f0-9-]+/)![0]
      for (let index = 0; index < 6; index++) registry.register(`https://unused.invalid/${index}.ts`)
      now = 600_001
      expect(await (await registry.handle(new Request(child))).text()).toBe('video')
      revision = 'b'
      const updated = await (await registry.handle(new Request(root))).text()
      const nextChild = updated.match(/app:\/\/app\/media\/[a-f0-9-]+/)![0]
      expect(nextChild).not.toBe(child)
      now += 600_001
      expect((await registry.handle(new Request(child))).status).toBe(404)
      expect(await (await registry.handle(new Request(nextChild))).text()).toBe('video')
      network.controller.abort()
      expect((await registry.handle(new Request(root))).status).toBe(404)
      expect((await registry.handle(new Request(nextChild))).status).toBe(404)
    } finally { await registry.dispose() }
  })

  it('strips source account headers from a cross-origin child instead of refusing the playlist', async () => {
    const network = owner(), headers: Headers[] = []
    const registry = new MediaRegistry({ config, resolve: async () => ['8.8.8.8'], fetchImpl: async (_input, init) => {
      headers.push(new Headers(init?.headers))
      return headers.length === 1 ? new Response('#EXTM3U\n#EXTINF:2,\nhttps://other.invalid/video.ts\n') : new Response('video')
    } })
    try {
      const root = registry.register('https://media.invalid/live.m3u8', { Cookie: 'root-only=synthetic', Authorization: 'Bearer root-only' }, network)
      const body = await (await registry.handle(new Request(root))).text()
      const child = body.match(/app:\/\/app\/media\/[a-f0-9-]+/)![0]
      expect(await (await registry.handle(new Request(child))).text()).toBe('video')
      expect(headers[0]!.get('Cookie')).toBe('root-only=synthetic')
      expect(headers[1]!.get('Cookie')).toBeNull()
      expect(headers[1]!.get('Authorization')).toBeNull()
    } finally { await registry.dispose() }
  })
})
