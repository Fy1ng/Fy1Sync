import { createServer, request, type RequestListener, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../server/config'
import type { NetworkContext } from '../server/networkPolicy'
import { MediaGateway } from './mediaGateway'

const active: MediaGateway[] = []
const upstreams: Server[] = []
afterEach(async () => {
  await Promise.all(active.splice(0).map(gateway => gateway.dispose()))
  await Promise.all(upstreams.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})
const config = { ...resolveConfig({}).proxy, hosts: ['fixture.invalid', 'cdn.fixture.invalid'], requestTimeoutMs: 5_000 }
const target = 'https://fixture.invalid/live/index.m3u8?signature=PRIVATE'
const context = (): NetworkContext => ({ route: vi.fn(async () => ({ kind: 'direct' as const })) })

function gateway(fetchImpl: typeof fetch, resolve = async () => ['93.184.216.34']) {
  const value = new MediaGateway(config, { fetchImpl, resolve })
  active.push(value)
  return value
}

function local(url: string, options: { method?: string; headers?: Record<string, string>; path?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(url, options, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function actualUpstream(handler: RequestListener) {
  const server = createServer(handler)
  upstreams.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  return `http://127.0.0.1:${address.port}`
}

function rawRequest(url: string, lines: string[]): Promise<number> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname)
    let response = ''
    socket.setTimeout(2_000, () => socket.destroy(new Error('Raw fixture request timed out')))
    socket.once('connect', () => socket.end(`GET ${target.pathname} HTTP/1.1\r\n${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`))
    socket.on('data', bytes => { response += bytes.toString() })
    socket.once('end', () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
      if (status) resolve(Number(status)); else reject(new Error('Missing raw fixture status'))
    })
    socket.once('error', reject)
  })
}

describe('FFmpeg controlled media gateway', () => {
  it('counts actual media bytes per input, includes child segments and excludes rewritten playlists', async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => String(input).endsWith('segment.ts')
      ? new Response('0123456789', { headers: { 'content-type': 'video/mp2t' } })
      : new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })) as unknown as typeof fetch
    const media = gateway(upstream)
    const first = await media.register(target, undefined, context())
    const second = await media.register(target, undefined, context())
    const playlist = await local(first.url)
    expect(first.readBytes()).toBe(0)
    const segment = playlist.body.match(/http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f-]{36}/)![0]
    expect((await local(segment)).body).toBe('0123456789')
    expect(first.readBytes()).toBe(10)
    expect(second.readBytes()).toBe(0)
  })

  it('exposes only opaque loopback capabilities and rewrites every nested media target', async () => {
    const network = context()
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      expect(init?.headers).toMatchObject({ Referer: 'https://fixture.invalid/player', Authorization: 'fixture-auth' })
      if (url === target) return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nsegment.ts?signature=PRIVATE_SEG\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
      return new Response(url.endsWith('key.bin') ? 'fixture-key' : 'fixture-segment', { headers: { 'content-type': 'video/mp2t' } })
    }) as unknown as typeof fetch
    const input = await gateway(upstream).register(target, { Referer: 'https://fixture.invalid/player', Authorization: 'fixture-auth' }, network)
    expect(input.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f-]{36}$/)
    expect(input.url).not.toContain('PRIVATE')
    expect(input.proxyUrl).toBe('')
    const response = await local(input.url)
    expect(response.status).toBe(200)
    const capabilities = response.body.match(/http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f-]{36}/g)!
    expect(capabilities).toHaveLength(2)
    expect(response.body).not.toContain('PRIVATE')
    expect((await local(capabilities[0]!)).body).toBe('fixture-key')
    expect((await local(capabilities[1]!)).body).toBe('fixture-segment')
    expect(vi.mocked(network.route).mock.calls.map(call => call[0])).toEqual([
      target, 'https://fixture.invalid/live/key.bin', 'https://fixture.invalid/live/segment.ts?signature=PRIVATE_SEG',
    ])
  })

  it('rejects foreign Host, URL overrides, arbitrary paths and write methods without fetching', async () => {
    const upstream = vi.fn(async () => new Response('unused')) as unknown as typeof fetch
    const input = await gateway(upstream).register(target, undefined, context())
    for (const options of [
      { headers: { host: 'evil.invalid' } },
      { path: new URL(input.url).pathname + '?url=http://127.0.0.1/private' },
      { path: 'https://fixture.invalid/arbitrary' },
      { path: '/media/not-a-capability' },
      { method: 'POST' },
    ]) expect((await local(input.url, options)).status).toBeGreaterThanOrEqual(400)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('rejects duplicate raw Host headers and well-formed unknown capabilities before fetching', async () => {
    const upstream = vi.fn(async () => new Response('unused')) as unknown as typeof fetch
    const input = await gateway(upstream).register(target, undefined, context())
    const host = new URL(input.url).host
    expect(await rawRequest(input.url, [`Host: ${host}`, `Host: ${host}`])).toBeGreaterThanOrEqual(400)
    expect(await rawRequest(input.url, [`Host: ${host}`, 'hOsT: evil.invalid'])).toBeGreaterThanOrEqual(400)
    expect((await local(input.url, { path: '/media/00000000-0000-4000-8000-000000000000' })).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('refuses explicit foreign or opaque browser origins and cross-site metadata even with a valid capability', async () => {
    const upstream = vi.fn(async () => new Response('unused')) as unknown as typeof fetch
    const input = await gateway(upstream).register(target, undefined, context())
    const attempts: Record<string, string>[] = [
      { origin: 'https://evil.invalid' },
      { origin: 'null' },
      { origin: 'app://app.evil.invalid' },
      { origin: 'http://localhost:' + new URL(input.url).port },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'app://app', 'sec-fetch-site': 'cross-site' },
      { referer: 'https://evil.invalid/player' },
      { referer: 'null' },
    ]
    for (const headers of attempts) {
      const response = await local(input.url, { headers })
      expect(response.status).toBe(403)
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('serves actual HTTP bytes for internal GET and HEAD while accepting FFmpeg without browser metadata', async () => {
    const seen: string[] = []
    const origin = await actualUpstream((request, response) => {
      seen.push(request.method!)
      response.writeHead(200, { 'content-type': 'video/mp2t' }).end('fixture-bytes')
    })
    const service = new MediaGateway({ ...config, hosts: ['127.0.0.1'], allowNonStandardPorts: true })
    active.push(service)
    const input = await service.register(`${origin}/segment.ts`, undefined, context())
    const internalOrigin = new URL(input.url).origin
    const attempts: Array<Record<string, string> | undefined> = [undefined,
      { origin: 'app://app', referer: 'app://app/', 'sec-fetch-site': 'same-origin' },
      { origin: internalOrigin, referer: `${internalOrigin}/player`, 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
    ]
    for (const headers of attempts) {
      for (const method of ['GET', 'HEAD']) {
        const response = await local(input.url, { method, headers })
        expect(response.status).toBe(200)
        expect(response.body).toBe(method === 'GET' ? 'fixture-bytes' : '')
      }
    }
    expect(seen).toEqual(['GET', 'HEAD', 'GET', 'HEAD', 'GET', 'HEAD', 'GET', 'HEAD'])
  })

  it('forwards HEAD and only approved request/response headers', async () => {
    const upstream = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.method).toBe('HEAD')
      expect(init?.headers).toMatchObject({ range: 'bytes=0-9', accept: 'video/*', 'if-none-match': 'fixture' })
      expect(init?.headers).not.toHaveProperty('cookie')
      expect(init?.headers).not.toHaveProperty('authorization')
      return new Response(null, { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '10', 'content-range': 'bytes 0-9/100', 'set-cookie': 'PRIVATE' } })
    }) as typeof fetch
    const input = await gateway(upstream).register('https://fixture.invalid/movie.mp4', undefined, context())
    const response = await local(input.url, { method: 'HEAD', headers: { range: 'bytes=0-9', accept: 'video/*', 'if-none-match': 'fixture', cookie: 'PRIVATE', authorization: 'PRIVATE' } })
    expect(response.status).toBe(206)
    expect(response.body).toBe('')
    expect(response.headers['content-range']).toBe('bytes 0-9/100')
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('retains the true proxy/TLS failure without exposing upstream diagnostics', async () => {
    const upstream = (async () => { throw Object.assign(new Error('https://fixture.invalid?signature=PRIVATE Cookie: PRIVATE'), { code: 'CERT_HAS_EXPIRED' }) }) as typeof fetch
    const input = await gateway(upstream).register(target, undefined, context())
    const response = await local(input.url)
    expect(response.status).toBe(502)
    expect(input.readFailure()).toMatchObject({ stage: 'connect', code: 'tls-certificate' })
    expect(JSON.stringify(input.readFailure()) + response.body).not.toMatch(/PRIVATE|signature|Cookie/)
    const copy = input.readFailure()!
    copy.code = 'tampered'
    expect(input.readFailure()?.code).toBe('tls-certificate')
  })

  it('routes each redirected URL through the same context and isolates sessions', async () => {
    const first = context()
    const second = context()
    const upstream = vi.fn(async input => String(input) === target
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.fixture.invalid/playlist.m3u8' } })
      : new Response(null, { status: 429 })) as typeof fetch
    const service = gateway(upstream)
    const one = await service.register(target, undefined, first)
    const two = await service.register(target, undefined, second)
    expect(one.url).not.toBe(two.url)
    expect((await local(one.url)).status).toBe(429)
    expect(vi.mocked(first.route).mock.calls.map(call => call[0])).toEqual([target, 'https://cdn.fixture.invalid/playlist.m3u8'])
    expect(one.readFailure()).toMatchObject({ stage: 'http', status: 429 })
    expect(two.readFailure()).toBeUndefined()
  })

  it('associates failures from nested segments with their input and clears diagnostics for a new input', async () => {
    const upstream = vi.fn(async input => String(input) === target
      ? new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
      : new Response(null, { status: 403 })) as typeof fetch
    const service = gateway(upstream)
    const network = context()
    const input = await service.register(target, undefined, network)
    const playlist = await local(input.url)
    const nested = playlist.body.trim().split('\n').at(-1)!
    expect((await local(nested)).status).toBe(403)
    expect(input.readFailure()).toMatchObject({ stage: 'http', status: 403 })
    const retry = await service.register(target, undefined, network)
    expect(retry.readFailure()).toBeUndefined()
    expect(input.readFailure()).toMatchObject({ stage: 'http', status: 403 })
  })

  it('records an upstream streaming error after response headers were delivered', async () => {
    let fail: (() => void) | undefined
    const upstream = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1]))
      fail = () => controller.error(Object.assign(new Error('PRIVATE Cookie=PRIVATE'), { code: 'ECONNRESET' }))
    } }), { headers: { 'content-type': 'video/mp2t' } })) as typeof fetch
    const input = await gateway(upstream).register('https://fixture.invalid/segment.ts', undefined, context())
    const response = await fetch(input.url)
    fail!()
    await expect(response.arrayBuffer()).rejects.toThrow()
    await vi.waitFor(() => expect(input.readFailure()).toMatchObject({ stage: 'connect' }))
    expect(JSON.stringify(input.readFailure())).not.toContain('PRIVATE')
  })

  it.each(['video/x-flv', 'application/octet-stream'])('keeps continuous FLV with %s alive beyond the request timeout while bytes progress', async contentType => {
    let producerFinished = false
    const upstream = vi.fn(async (_input, init) => new Response(new ReadableStream({ start(controller) {
      let count = 0
      const timer = setInterval(() => {
        controller.enqueue(new Uint8Array([++count]))
        if (count === 8) { producerFinished = true; clearInterval(timer); controller.close() }
      }, 15)
      init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(new Error('aborted')) }, { once: true })
    } }), { headers: { 'content-type': contentType } })) as typeof fetch
    const service = new MediaGateway({ ...config, requestTimeoutMs: 60 }, { fetchImpl: upstream, resolve: async () => ['93.184.216.34'] })
    active.push(service)
    const input = await service.register('https://fixture.invalid/live.flv', undefined, context())
    const response = await fetch(input.url)
    expect(producerFinished).toBe(false)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(input.readFailure()).toBeUndefined()
  })

  it('aborts a live FLV response if upstream bytes stop progressing', async () => {
    const upstream = vi.fn(async (_input, init) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1]))
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
    } }), { headers: { 'content-type': 'video/x-flv' } })) as typeof fetch
    const service = new MediaGateway({ ...config, requestTimeoutMs: 25 }, { fetchImpl: upstream, resolve: async () => ['93.184.216.34'] })
    active.push(service)
    const input = await service.register('https://fixture.invalid/live.flv', undefined, context())
    const response = await fetch(input.url)
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(input.readFailure()).toMatchObject({ stage: 'connect', code: 'connection-timeout' })
  })

  it('aborts upstream work after the local client disconnects', async () => {
    let signal: AbortSignal | undefined
    const upstream = vi.fn(async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      } }), { headers: { 'content-type': 'video/mp2t' } })
    }) as typeof fetch
    const input = await gateway(upstream).register('https://fixture.invalid/segment.ts', undefined, context())
    await new Promise<void>((resolve, reject) => {
      const req = request(input.url, response => {
        response.once('data', () => { response.destroy(); resolve() })
        response.on('error', () => {})
      })
      req.on('error', reject)
      req.end()
    })
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  })

  it('closes active connections and refuses new registrations on disposal', async () => {
    const closed = vi.fn()
    const origin = await actualUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'video/mp2t' }).write(Buffer.from([1]))
      response.once('close', closed)
    })
    const service = new MediaGateway({ ...config, hosts: ['127.0.0.1'], allowNonStandardPorts: true })
    active.push(service)
    const input = await service.register(`${origin}/segment.ts`, undefined, context())
    const stream = await fetch(input.url)
    const reader = stream.body!.getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1]))
    await service.dispose()
    await expect(reader.read()).rejects.toThrow()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    await expect(service.register(target, undefined, context())).rejects.toThrow('已关闭')
    await expect(local(input.url)).rejects.toThrow()
  })
})
