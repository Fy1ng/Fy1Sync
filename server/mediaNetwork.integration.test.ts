/** Real loopback HTTP sockets exercise media policy, HLS rewriting and connection ownership. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { metadataConfig, resolveConfig } from './config'
import { MediaRegistry, type MediaDeps } from './mediaProxy'
import { directNetwork, type NetworkContext } from './networkPolicy'
import { safeFetch } from './safeFetch'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })
const config = { ...resolveConfig({}).proxy, requestTimeoutMs: 3_000 }
const request = (url: string, init?: RequestInit) => new Request(url, init)

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void, host = '127.0.0.1', port = 0) {
  const server = createServer(handler)
  const sockets = new Set<Socket>()
  let connections = 0
  server.on('connection', socket => {
    connections++
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address')
  return { origin: `http://${host}:${address.port}`, port: address.port, sockets, get connections() { return connections } }
}

function registry(overrides: Partial<MediaDeps> = {}) {
  const value = new MediaRegistry({ config, network: directNetwork, ...overrides })
  cleanup.push(() => value.dispose())
  return value
}

const capabilities = (body: string) => body.match(/app:\/\/app\/media\/[0-9a-f-]{36}/g) ?? []
async function readText(value: MediaRegistry, url: string, init?: RequestInit) {
  const response = await value.handle(request(url, init))
  return { response, body: await response.text() }
}

describe('ordinary media over real loopback HTTP', () => {
  it('loads a signed relative HLS segment, AES key and init file on a user-selected random port', async () => {
    const seen: Array<{ path: string; range?: string }> = []
    const key = Buffer.from(Array.from({ length: 16 }, (_, index) => index))
    const source = await upstream((incoming, response) => {
      seen.push({ path: incoming.url!, range: incoming.headers.range })
      if (incoming.url === '/live/index.m3u8?signature=TOP_PRIVATE') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end([
          '#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="../keys/aes.bin?signature=KEY_PRIVATE%2B%2F"',
          '#EXT-X-MAP:URI="init.mp4?signature=INIT_PRIVATE"', '#EXTINF:4,', 'segment.ts?signature=SEG_PRIVATE%2B%2F', '',
        ].join('\n'))
      } else if (incoming.url === '/keys/aes.bin?signature=KEY_PRIVATE%2B%2F') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(key)
      } else {
        response.writeHead(200, { 'content-type': 'video/mp2t' }).end(incoming.url!.includes('init.mp4') ? 'init-bytes' : 'segment-bytes')
      }
    })
    const media = registry()
    const top = media.register(`${source.origin}/live/index.m3u8?signature=TOP_PRIVATE`)
    const playlist = await readText(media, top, { headers: { range: 'bytes=0-99' } })
    expect(playlist.response.status).toBe(200)
    expect(playlist.body).not.toContain('PRIVATE')
    const [keyUrl, initUrl, segmentUrl] = capabilities(playlist.body)
    expect(capabilities(playlist.body)).toHaveLength(3)
    expect(Buffer.from(await (await media.handle(request(keyUrl!))).arrayBuffer())).toEqual(key)
    expect((await readText(media, initUrl!)).body).toBe('init-bytes')
    expect((await readText(media, segmentUrl!)).body).toBe('segment-bytes')
    expect(seen).toEqual([
      { path: '/live/index.m3u8?signature=TOP_PRIVATE', range: undefined },
      { path: '/keys/aes.bin?signature=KEY_PRIVATE%2B%2F', range: undefined },
      { path: '/live/init.mp4?signature=INIT_PRIVATE', range: undefined },
      { path: '/live/segment.ts?signature=SEG_PRIVATE%2B%2F', range: undefined },
    ])
  })

  it('reuses exactly one TCP connection for a playlist and twelve sequential HLS segments', async () => {
    let requests = 0
    const source = await upstream((incoming, response) => {
      requests++
      if (incoming.url === '/index.m3u8') {
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end('#EXTM3U\n'
          + Array.from({ length: 12 }, (_, index) => `#EXTINF:4,\nsegment-${index}.ts?signature=PRIVATE_${index}\n`).join(''))
      } else response.writeHead(200, { 'content-type': 'video/mp2t' }).end('sealed-segment')
    })
    const media = registry()
    const playlist = await readText(media, media.register(`${source.origin}/index.m3u8`))
    const urls = capabilities(playlist.body)
    expect(urls).toHaveLength(12)
    await nextTurn()
    for (const url of urls) {
      expect((await readText(media, url)).body).toBe('sealed-segment')
      // Let Undici mark the consumed socket idle before the next sequential request.
      await nextTurn()
    }
    expect(requests).toBe(13)
    expect(source.connections).toBe(1)
    await media.dispose()
    await vi.waitFor(() => expect(source.sockets.size).toBe(0))
  })

  it('uses separate actual sockets for credential headers and network contexts while reusing each owner', async () => {
    const seen: Array<{ socket: Socket; authorization?: string }> = []
    const source = await upstream((incoming, response) => {
      seen.push({ socket: incoming.socket, authorization: incoming.headers.authorization })
      response.writeHead(200, { 'content-type': 'video/mp2t' }).end('owner-bytes')
    })
    const media = registry()
    const one: NetworkContext = { route: directNetwork.route }
    const two: NetworkContext = { route: directNetwork.route }
    const urls = [
      media.register(`${source.origin}/segment.ts`, { Authorization: 'Bearer SYNTHETIC_A' }, one),
      media.register(`${source.origin}/segment.ts`, { Authorization: 'Bearer SYNTHETIC_B' }, one),
      media.register(`${source.origin}/segment.ts`, { Authorization: 'Bearer SYNTHETIC_A' }, two),
    ]
    for (const url of urls) for (let index = 0; index < 2; index++) {
      expect((await readText(media, url)).body).toBe('owner-bytes')
      await nextTurn()
    }
    expect(seen.map(item => item.authorization)).toEqual([
      'Bearer SYNTHETIC_A', 'Bearer SYNTHETIC_A', 'Bearer SYNTHETIC_B', 'Bearer SYNTHETIC_B', 'Bearer SYNTHETIC_A', 'Bearer SYNTHETIC_A',
    ])
    expect(seen[0]!.socket).toBe(seen[1]!.socket)
    expect(seen[2]!.socket).toBe(seen[3]!.socket)
    expect(seen[4]!.socket).toBe(seen[5]!.socket)
    expect(new Set(seen.map(item => item.socket)).size).toBe(3)
    expect(source.connections).toBe(3)
  })

  it('repins a real connection after DNS changes instead of reusing the old address socket', async () => {
    const first = await upstream((_incoming, response) => response.writeHead(200, { 'content-type': 'video/mp2t' }).end('first-address'))
    const second = await upstream((_incoming, response) => response.writeHead(200, { 'content-type': 'video/mp2t' }).end('second-address'), '127.0.0.2', first.port)
    let address = '127.0.0.1'
    const resolve = vi.fn(async () => [address])
    const media = registry({ resolve })
    const url = media.register(`http://media-fixture.invalid:${first.port}/segment.ts`)
    expect((await readText(media, url)).body).toBe('first-address')
    await nextTurn()
    address = '127.0.0.2'
    expect((await readText(media, url)).body).toBe('second-address')
    expect(first.connections).toBe(1)
    expect(second.connections).toBe(1)
    expect(resolve.mock.calls).toEqual([['media-fixture.invalid'], ['media-fixture.invalid']])
  })

  it('forwards actual byte ranges and HEAD without forwarding caller credentials', async () => {
    const seen: Array<{ method: string; range?: string; cookie?: string }> = []
    const source = await upstream((incoming, response) => {
      seen.push({ method: incoming.method!, range: incoming.headers.range, cookie: incoming.headers.cookie })
      response.writeHead(206, { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 2-5/10', 'accept-ranges': 'bytes' })
      response.end(incoming.method === 'HEAD' ? undefined : '2345')
    })
    const media = registry()
    const url = media.register(`${source.origin}/movie.mp4?signature=PRIVATE`)
    for (const method of ['GET', 'HEAD']) {
      const result = await readText(media, url, { method, headers: { range: 'bytes=2-5', cookie: 'CALLER_PRIVATE' } })
      expect(result.response.status).toBe(206)
      expect(result.response.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(result.body).toBe(method === 'GET' ? '2345' : '')
    }
    expect(seen).toEqual([{ method: 'GET', range: 'bytes=2-5', cookie: undefined }, { method: 'HEAD', range: 'bytes=2-5', cookie: undefined }])
  })

  it('keeps a real continuous FLV stream alive beyond the request budget while bytes progress', async () => {
    const source = await upstream((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'video/x-flv' })
      response.write('FLV')
      let chunks = 0
      const timer = setInterval(() => {
        response.write(Buffer.from([++chunks]))
        if (chunks === 8) { clearInterval(timer); response.end() }
      }, 30)
      response.once('close', () => clearInterval(timer))
    })
    const media = registry({ config: { ...config, requestTimeoutMs: 120 } })
    const response = await media.handle(request(media.register(`${source.origin}/live.flv`)))
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes).toEqual(Buffer.concat([Buffer.from('FLV'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]))
  })

  it('cancels the actual upstream response when a media consumer disconnects', async () => {
    const closed = vi.fn()
    const source = await upstream((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'video/x-flv' }).write('FLV')
      response.once('close', closed)
    })
    const media = registry()
    const controller = new AbortController()
    const response = await media.handle(request(media.register(`${source.origin}/live.flv`), { signal: controller.signal }))
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('FLV')
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(source.sockets.size).toBe(0))
  })

  it.each(['segment', 'redirect'] as const)('blocks a different local origin discovered through a real hostname-mapped playlist %s', async mode => {
    const blockedRequests = vi.fn()
    const other = await upstream((_incoming, response) => { blockedRequests(); response.end('must-not-be-read') })
    const seen: string[] = []
    const source = await upstream((incoming, response) => {
      seen.push(incoming.url!)
      if (incoming.url === '/index.m3u8') {
        const child = mode === 'segment' ? `${other.origin}/private.ts` : '/redirect.ts'
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }).end(`#EXTM3U\n#EXTINF:4,\n/allowed.ts\n#EXTINF:4,\n${child}\n`)
      } else if (incoming.url === '/redirect.ts') response.writeHead(302, { location: `${other.origin}/private.ts` }).end()
      else response.writeHead(200, { 'content-type': 'video/mp2t' }).end('same-origin-allowed')
    })
    const media = registry({ resolve: async () => ['127.0.0.1'] })
    const playlist = await readText(media, media.register(`http://public-name.invalid:${source.port}/index.m3u8`))
    const [allowed, blocked] = capabilities(playlist.body)
    expect((await readText(media, allowed!)).body).toBe('same-origin-allowed')
    const rejected = await readText(media, blocked!)
    expect(rejected.response.status).toBe(403)
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: 'media-network-boundary' } })
    expect(blockedRequests).not.toHaveBeenCalled()
    expect(seen).toEqual(mode === 'segment' ? ['/index.m3u8', '/allowed.ts'] : ['/index.m3u8', '/allowed.ts', '/redirect.ts'])
  })

  it('keeps the strict API hostname and standard-port rules while media uses its separate policy', async () => {
    const received = vi.fn()
    const source = await upstream((_incoming, response) => { received(); response.writeHead(200, { 'content-type': 'video/mp2t' }).end('media-only') })
    const url = `http://metadata-fixture.invalid:${source.port}/segment.ts`
    await expect(safeFetch(url, metadataConfig(), { network: directNetwork, resolve: async () => ['127.0.0.1'] })).rejects.toMatchObject({ reason: 'bad-port' })
    await expect(safeFetch('http://metadata-fixture.invalid/segment.ts', metadataConfig(), { network: directNetwork,
      resolve: async () => ['127.0.0.1'] })).rejects.toMatchObject({ reason: 'host-not-allowed' })
    expect(received).not.toHaveBeenCalled()
    const media = registry({ resolve: async () => ['127.0.0.1'] })
    expect((await readText(media, media.register(url))).body).toBe('media-only')
    expect(received).toHaveBeenCalledOnce()
  })
})

describe('simulated public CDN addresses without public network requests', () => {
  it('allows cross-public CDN and Fake-IP playlist children while refusing literal LAN targets', async () => {
    const seen: string[] = []
    const media = registry({ resolve: async host => [host === 'fake-cdn.invalid' ? '198.18.0.2' : '93.184.216.34'],
      fetchImpl: async input => {
        const url = String(input)
        seen.push(url)
        return url.includes('/index.m3u8') ? new Response([
          '#EXTM3U', '#EXTINF:4,', 'https://different-public.invalid:8443/segment.ts',
          '#EXTINF:4,', 'http://fake-cdn.invalid:8080/segment.ts', '#EXTINF:4,', 'http://192.168.1.20:8080/private.ts', '',
        ].join('\n'), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
          : new Response('simulated-cdn-bytes', { headers: { 'content-type': 'video/mp2t' } })
      },
    })
    const playlist = await readText(media, media.register('https://public-media.invalid/index.m3u8'))
    const [publicChild, fakeIpChild, localChild] = capabilities(playlist.body)
    expect((await readText(media, publicChild!)).body).toBe('simulated-cdn-bytes')
    expect((await readText(media, fakeIpChild!)).body).toBe('simulated-cdn-bytes')
    const rejected = await readText(media, localChild!)
    expect(rejected.response.status).toBe(403)
    expect(JSON.parse(rejected.body)).toMatchObject({ error: { code: 'media-network-boundary' } })
    expect(seen).toEqual(['https://public-media.invalid/index.m3u8', 'https://different-public.invalid:8443/segment.ts', 'http://fake-cdn.invalid:8080/segment.ts'])
  })
})
