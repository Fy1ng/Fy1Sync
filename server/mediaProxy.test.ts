import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from './config'
import { MediaRegistry, type MediaDeps } from './mediaProxy'
import { StreamFailureError } from './networkFailure'

const TARGET = 'https://video-weaver.ttvnw.net/live/index.m3u8'
const PLAYLIST = '#EXTM3U\n#EXTINF:4,\nseg.ts\n'
function fixture(body: string | Uint8Array = PLAYLIST, overrides: Partial<MediaDeps> = {}, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return new Response(body as BodyInit, { headers: { 'content-type': typeof body === 'string' ? 'application/vnd.apple.mpegurl' : 'video/mp2t', ...headers } })
  }) as unknown as typeof fetch
  const registry = new MediaRegistry({ config: resolveConfig({}).proxy, resolve: async () => ['93.184.216.34'], fetchImpl, ...overrides })
  return { registry, calls, fetchImpl, url: registry.register(TARGET) }
}
const request = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Request(url, { method, headers })

describe('registered media capabilities', () => {
  it('exposes an opaque same-origin URL without upstream query values', () => {
    const { registry } = fixture()
    const url = registry.register('https://video-weaver.ttvnw.net/x.mp4?signature=fixture')
    expect(url).toMatch(/^app:\/\/app\/media\/[0-9a-f-]{36}$/)
    expect(url).not.toContain('signature')
    expect(registry.register('https://video-weaver.ttvnw.net/x.mp4?signature=fixture')).toBe(url)
  })
  it('never fetches an arbitrary renderer-supplied URL', async () => {
    const f = fixture()
    for (const path of ['unregistered', 'unregistered?url=http://127.0.0.1/secret']) {
      expect((await f.registry.handle(request('app://app/media/' + path))).status).toBeGreaterThanOrEqual(400)
    }
    expect(f.calls).toHaveLength(0)
  })
  it('refuses foreign origins and query overrides even with a valid ID', async () => {
    const f = fixture()
    expect((await f.registry.handle(request(f.url.replace('app://app', 'app://foreign')))).status).toBe(403)
    expect((await f.registry.handle(request(f.url + '?url=https://example.com'))).status).toBe(403)
  })
  it('rejects non-http and credential-bearing registrations', () => {
    const f = fixture()
    for (const url of ['file:///secret', 'javascript:alert(1)', 'https://user:pass@example.com']) expect(() => f.registry.register(url)).toThrow()
  })
  it('expires capabilities and clears all resources on shutdown', async () => {
    let now = 0
    const f = fixture(PLAYLIST, { now: () => now })
    now = 600_001
    expect((await f.registry.handle(request(f.url))).status).toBe(404)
    const next = f.registry.register(TARGET)
    f.registry.clear()
    expect((await f.registry.handle(request(next))).status).toBe(404)
  })
  it('bounds the registry while keeping current capability mappings consistent', async () => {
    const f = fixture()
    for (let i=0;i<8192;i++) f.registry.register('https://video-weaver.ttvnw.net/' + i + '.ts')
    expect((await f.registry.handle(request(f.url))).status).toBe(404)
  })
  it('refuses writes', async () => {
    const f = fixture()
    expect((await f.registry.handle(request(f.url, {}, 'POST'))).status).toBe(405)
  })
  it('honors the disabled media capability', async () => {
    const f = fixture(PLAYLIST, { config: { ...resolveConfig({}).proxy, enabled: false } })
    expect((await f.registry.handle(request(f.url))).status).toBe(503)
  })
  it('reads an explicitly selected media host outside the API allow list', async () => {
    const f = fixture()
    const url = f.registry.register('https://custom-media.example:8443/a.mp4')
    const response = await f.registry.handle(request(url))
    expect(response.status).toBe(200)
    await response.body?.cancel()
    expect(f.calls).toHaveLength(1)
  })
  it('blocks invalid DNS results before fetch', async () => {
    const f = fixture(PLAYLIST, { resolve: async () => ['not-an-ip'] })
    expect((await f.registry.handle(request(f.url))).status).toBe(403)
    expect(f.calls).toHaveLength(0)
  })
})

describe('media fetch and HLS', () => {
  it('forwards only approved request headers and fixed platform Referer', async () => {
    const f = fixture(new Uint8Array([1,2]))
    const url = f.registry.register('https://test.bilivideo.com/a.mp4')
    const response = await f.registry.handle(request(url, { range: 'bytes=0-1', accept: 'video/*', 'if-none-match': 'old', cookie: 'test-cookie', authorization: 'test-auth', referer: 'https://evil.example' }))
    await response.arrayBuffer()
    expect(f.calls[0]!.init.headers).toMatchObject({ range: 'bytes=0-1', accept: 'video/*', 'if-none-match': 'old', referer: 'https://live.bilibili.com/', 'user-agent': 'StreamSyncer/0.1 (+desktop)' })
    expect(f.calls[0]!.init.headers).not.toHaveProperty('cookie')
    expect(f.calls[0]!.init.headers).not.toHaveProperty('authorization')
  })
  it('passes only allowed response headers', async () => {
    const f = fixture(new Uint8Array([1]), {}, { 'set-cookie': 'test-cookie', 'x-secret': 'discard', 'accept-ranges': 'bytes', etag: 'tag' })
    const response = await f.registry.handle(request(f.url))
    await response.arrayBuffer()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-secret')).toBeNull()
    expect(response.headers.get('etag')).toBe('tag')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
  })
  it('rewrites segments, keys, maps and rendition playlists to capabilities', async () => {
    const source = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXTINF:4,\nseg.ts\n'
    const f = fixture(source)
    const response = await f.registry.handle(request(f.url))
    const text = await response.text()
    expect(text).not.toContain('https://')
    expect(text.match(/app:\/\/app\/media\//g)).toHaveLength(4)
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)))
    expect(response.headers.get('cache-control')).toBe('no-store')
    const segment = text.trim().split('\n').at(-1)!
    await (await f.registry.handle(request(segment))).body?.cancel()
    expect(f.calls.at(-1)!.url).toBe('https://video-weaver.ttvnw.net/live/seg.ts')
  })
  it('removes FFmpeg probe ranges from known playlists before rewriting their complete body', async () => {
    const f = fixture()
    const response = await f.registry.handle(request(f.url, { range: 'bytes=0-' }))
    expect(f.calls[0]!.init.headers).not.toHaveProperty('range')
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('/media/')
    expect(text).not.toContain('\nseg.ts')
  })
  it('retries a ranged opaque playlist without Range and rewrites the full response', async () => {
    const calls: RequestInit[] = []
    const upstream = vi.fn(async (_input, init: RequestInit = {}) => {
      calls.push({ ...init, headers: { ...init.headers } })
      return new Response(PLAYLIST, { status: calls.length === 1 ? 206 : 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
    }) as typeof fetch
    const f = fixture(PLAYLIST, { fetchImpl: upstream })
    const opaque = f.registry.register('https://video-weaver.ttvnw.net/opaque?synthetic-signature=value')
    const response = await f.registry.handle(request(opaque, { range: 'bytes=0-' }))
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers).toHaveProperty('range', 'bytes=0-')
    expect(calls[1]!.headers).not.toHaveProperty('range')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('/media/')
  })
  it('uses the final redirect URL when registering relative segments', async () => {
    const seen: string[] = []
    const f = fixture(PLAYLIST, { fetchImpl: (async (url) => {
      seen.push(String(url))
      return String(url) === TARGET ? new Response(null, { status: 302, headers: { location: '/redirect/index.m3u8' } }) : new Response(PLAYLIST, { headers: { 'content-type': 'text/plain' } })
    }) as typeof fetch })
    const text = await (await f.registry.handle(request(f.url))).text()
    await (await f.registry.handle(request(text.trim().split('\n').at(-1)!))).body?.cancel()
    expect(seen.at(-1)).toBe('https://video-weaver.ttvnw.net/redirect/seg.ts')
  })
  it('rewrites opaque signed playlists labelled as octet-stream', async () => {
    const f = fixture(PLAYLIST, {}, { 'content-type': 'application/octet-stream' })
    const url = f.registry.register('https://video-weaver.ttvnw.net/v1/CvYE...signed')
    const text = await (await f.registry.handle(request(url))).text()
    await (await f.registry.handle(request(text.trim().split('\n').at(-1)!))).body?.cancel()
    expect(f.calls.at(-1)!.url).toBe('https://video-weaver.ttvnw.net/v1/seg.ts')
  })
  it('refuses unsafe URI schemes found in a playlist', async () => {
    const f = fixture('#EXTM3U\nfile:///secret\n')
    expect((await f.registry.handle(request(f.url))).status).toBe(502)
  })
  it('rejects an automatic redirect crossing into an ungranted local origin', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.ts' } })) as typeof fetch })
    expect((await f.registry.handle(request(f.url))).status).toBe(403)
  })
  it('allows anonymous cross-CDN HLS resources on non-standard ports', async () => {
    const f = fixture('#EXTM3U\n#EXTINF:4,\nhttps://another-cdn.example:8080/seg.ts?signature=fixture\n')
    const playlist = await (await f.registry.handle(request(f.url))).text()
    const child = playlist.trim().split('\n').at(-1)!
    await (await f.registry.handle(request(child))).body?.cancel()
    expect(f.calls.at(-1)!.url).toBe('https://another-cdn.example:8080/seg.ts?signature=fixture')
  })
  it.each(['http://127.0.0.1:8080/private', 'http://192.168.1.2:8000/private', 'http://localhost/private'])('rejects automatically discovered local service %s', async target => {
    const f = fixture(`#EXTM3U\n#EXTINF:4,\n${target}\n`)
    const playlist = await (await f.registry.handle(request(f.url))).text()
    const child = playlist.trim().split('\n').at(-1)!
    const response = await f.registry.handle(request(child))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'media-network-boundary' } })
    expect(f.calls).toHaveLength(1)
  })
  it('accepts a chosen local HLS origin but never grants another port in the same playlist', async () => {
    const f = fixture('#EXTM3U\n#EXTINF:4,\nseg.ts\n#EXTINF:4,\nhttp://127.0.0.1:8000/private\n')
    const top = f.registry.register('http://127.0.0.1:8080/live.m3u8')
    const text = await (await f.registry.handle(request(top))).text()
    const children = text.match(/app:\/\/app\/media\/[a-f0-9-]+/g)!
    expect((await f.registry.handle(request(children[0]!))).status).toBe(200)
    expect((await f.registry.handle(request(children[1]!))).status).toBe(403)
    expect(f.calls).toHaveLength(2)
  })
  it('rejects a same-origin public playlist that rebinds to a local IP for its segment', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['127.0.0.1'])
    const f = fixture(PLAYLIST, { resolve })
    const text = await (await f.registry.handle(request(f.url))).text()
    expect((await f.registry.handle(request(text.trim().split('\n').at(-1)!))).status).toBe(403)
    expect(f.calls).toHaveLength(1)
  })
  it.each(['Cookie', 'Authorization', 'X-API-Key'])('does not carry %s to an HLS CDN origin', async name => {
    const f = fixture('#EXTM3U\nhttps://another-cdn.example/seg.ts\n')
    const response = await f.registry.handle(request(f.registry.register(TARGET, { [name]: 'PRIVATE_CREDENTIAL' })))
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('PRIVATE_CREDENTIAL')
    expect(f.calls).toHaveLength(1)
  })
  it('preserves mislabelled binary bytes without text transcoding', async () => {
    const bytes = new Uint8Array([255,0,128,99])
    const f = fixture(bytes, {}, { 'content-type': 'application/vnd.apple.mpegurl' })
    expect(new Uint8Array(await (await f.registry.handle(request(f.url))).arrayBuffer())).toEqual(bytes)
  })
  it('streams large mislabeled binary data instead of applying the playlist body limit', async () => {
    const bytes = new Uint8Array(4_194_305).fill(255)
    const f = fixture(bytes, {}, { 'content-type': 'application/vnd.apple.mpegurl' })
    const response = await f.registry.handle(request(f.url))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
  })
  it('rewrites a playlist disguised as binary MP4 before FFmpeg can discover unguarded resources', async () => {
    const f = fixture('#EXTM3U\n#EXTINF:4,\nhttp://127.0.0.1:8080/private\n', {}, { 'content-type': 'video/mp4' })
    const top = f.registry.register('https://custom.example/video.mp4')
    const text = await (await f.registry.handle(request(top))).text()
    expect(text).not.toContain('http://127.0.0.1')
    const response = await f.registry.handle(request(text.trim().split('\n').at(-1)!))
    expect(response.status).toBe(403)
    expect(f.calls).toHaveLength(1)
  })
  it('retries a disguised ranged MP4 playlist in full before rewriting its resources', async () => {
    const calls: RequestInit[] = []
    const f = fixture(PLAYLIST, { fetchImpl: (async (_url, init = {}) => {
      calls.push(init)
      return new Response(PLAYLIST, { status: calls.length === 1 ? 206 : 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch })
    const text = await (await f.registry.handle(request(f.registry.register('https://custom.example/video.mp4'), { range: 'bytes=0-1023' }))).text()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.headers).not.toHaveProperty('range')
    expect(text).toContain('app://app/media/')
    expect(text).not.toContain('\nseg.ts')
  })
  it('streams media without whole-body text buffering', async () => {
    const bytes = new Uint8Array(4_194_305)
    const f = fixture(bytes)
    f.url = f.registry.register('https://video-weaver.ttvnw.net/clip.ts')
    expect((await (await f.registry.handle(request(f.url))).arrayBuffer()).byteLength).toBe(bytes.length)
  })
  it('caps playlists even when content-length is absent or false', async () => {
    const f = fixture('#EXTM3U\n' + 'a'.repeat(4_194_304), {}, { 'content-length': '1' })
    expect((await f.registry.handle(request(f.url))).status).toBe(413)
  })
  it('leaves upstream errors unrewritten', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async () => new Response('gone', { status: 404 })) as typeof fetch })
    const response = await f.registry.handle(request(f.url))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('gone')
  })
  it('preserves byte ranges and status', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async () => new Response('abc', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 10-12/100', 'content-length': '3' } })) as typeof fetch })
    const response = await f.registry.handle(request(f.url, { range: 'bytes=10-12' }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-12/100')
    expect(await response.text()).toBe('abc')
  })
  it('answers HEAD with no body and no rewrite', async () => {
    const f = fixture(PLAYLIST)
    const response = await f.registry.handle(request(f.url, {}, 'HEAD'))
    expect(await response.text()).toBe('')
    expect(f.calls[0]!.init.method).toBe('HEAD')
  })
  it('handles 304 responses without inventing a body', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async () => new Response(null, { status: 304 })) as typeof fetch })
    expect((await f.registry.handle(request(f.url))).status).toBe(304)
  })
  it('aborts a timed out upstream and reports a stable error', async () => {
    const f = fixture(PLAYLIST, { config: { ...resolveConfig({}).proxy, requestTimeoutMs: 5 }, fetchImpl: ((_, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private upstream details'))))) as typeof fetch })
    const response = await f.registry.handle(request(f.url))
    expect(response.status).toBe(504)
    expect(await response.text()).not.toContain('private upstream')
  })
  it('sanitizes transport failures', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async () => { throw new Error('private-url-signature') }) as typeof fetch })
    const response = await f.registry.handle(request(f.url))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('signature')
  })
  it('aborts upstream when the renderer cancels the response stream', async () => {
    let signal: AbortSignal | null | undefined
    let cancelled = false
    const f = fixture(PLAYLIST, { fetchImpl: (async (_url, init) => {
      signal = init?.signal
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch })
    const response = await f.registry.handle(request(f.registry.register('https://video-weaver.ttvnw.net/clip.mp4')))
    await response.body!.cancel()
    expect(signal!.aborted).toBe(true)
    expect(cancelled).toBe(true)
  })

  it('retries idempotent GET and HEAD on transient socket reset using a fresh non-pooled connection', async () => {
    for (const method of ['GET', 'HEAD'] as const) {
      const dispatchers: unknown[] = []
      const upstream = vi.fn(async (_url, init: RequestInit = {}) => {
        dispatchers.push((init as RequestInit & { dispatcher?: unknown }).dispatcher)
        if (dispatchers.length === 1) {
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          })
        }
        return new Response(method === 'HEAD' ? null : 'clean-segment', {
          status: 200,
          headers: { 'content-type': 'video/mp2t' },
        })
      }) as typeof fetch
      const f = fixture(PLAYLIST, { fetchImpl: upstream })
      const response = await f.registry.handle(request(f.registry.register('https://video-weaver.ttvnw.net/seg.ts'), {}, method))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(method === 'HEAD' ? '' : 'clean-segment')
      expect(dispatchers).toHaveLength(2)
      // Retry must bypass the pooled dispatcher so a stale keep-alive socket is not reused.
      expect(dispatchers[1]).not.toBe(dispatchers[0])
      await f.registry.dispose()
    }
  })

  it('retries transient 5xx responses on a fresh connection, cancels discarded bodies, and caps retries at two', async () => {
    const cancelled: number[] = []
    const dispatchers: unknown[] = []
    let calls = 0
    const upstream = vi.fn(async (_url, init: RequestInit = {}) => {
      const n = ++calls
      dispatchers.push((init as RequestInit & { dispatcher?: unknown }).dispatcher)
      if (n <= 2) {
        return new Response(new ReadableStream({ cancel() { cancelled.push(n) } }), { status: n === 1 ? 502 : 503 })
      }
      return new Response('recovered', { status: 200, headers: { 'content-type': 'video/mp2t' } })
    }) as typeof fetch
    const f = fixture(PLAYLIST, { fetchImpl: upstream })
    const response = await f.registry.handle(request(f.registry.register('https://video-weaver.ttvnw.net/seg.ts')))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('recovered')
    expect(calls).toBe(3)
    expect(cancelled).toEqual([1, 2])
    expect(dispatchers[1]).not.toBe(dispatchers[0])
    expect(dispatchers[2]).not.toBe(dispatchers[0])
    await f.registry.dispose()

    let failedCalls = 0
    const always504 = fixture(PLAYLIST, {
      fetchImpl: (async () => { failedCalls++; return new Response('gateway timeout', { status: 504 }) }) as typeof fetch,
    })
    const failed = await always504.registry.handle(request(always504.registry.register('https://video-weaver.ttvnw.net/stuck.ts')))
    expect(failed.status).toBe(504)
    expect(failedCalls).toBe(3)
    await always504.registry.dispose()
  })

  it('retries proxy-wrapped socket resets while refusing retries on 4xx, TLS, policy errors and client abort', async () => {
    let proxyCalls = 0
    const proxyReset = fixture(PLAYLIST, {
      fetchImpl: (async () => {
        if (++proxyCalls === 1) {
          throw new StreamFailureError({
            stage: 'proxy',
            code: 'proxy-failed',
            message: '代理不可达或拒绝连接',
            detail: { name: 'TypeError', cause: { code: 'ECONNRESET', message: 'connection reset' } },
          })
        }
        return new Response('ok-after-proxy-reset', { headers: { 'content-type': 'video/mp2t' } })
      }) as typeof fetch,
    })
    const recovered = await proxyReset.registry.handle(request(proxyReset.registry.register('https://video-weaver.ttvnw.net/p.ts')))
    expect(recovered.status).toBe(200)
    expect(await recovered.text()).toBe('ok-after-proxy-reset')
    expect(proxyCalls).toBe(2)
    await proxyReset.registry.dispose()

    for (const status of [403, 404, 429]) {
      let count = 0
      const f = fixture(PLAYLIST, { fetchImpl: (async () => { count++; return new Response('nope', { status }) }) as typeof fetch })
      expect((await f.registry.handle(request(f.url))).status).toBe(status)
      expect(count).toBe(1)
      await f.registry.dispose()
    }

    let tlsCount = 0
    const tlsFail = fixture(PLAYLIST, {
      fetchImpl: (async () => { tlsCount++; throw Object.assign(new Error('cert expired'), { code: 'CERT_HAS_EXPIRED' }) }) as typeof fetch,
    })
    expect((await tlsFail.registry.handle(request(tlsFail.url))).status).toBe(502)
    expect(tlsCount).toBe(1)
    await tlsFail.registry.dispose()

    let abortCalls = 0
    const controller = new AbortController()
    const aborting = fixture(PLAYLIST, {
      fetchImpl: (async () => {
        abortCalls++
        queueMicrotask(() => controller.abort())
        return new Response('busy', { status: 503 })
      }) as typeof fetch,
    })
    const abortedResponse = await aborting.registry.handle(new Request(aborting.url, { signal: controller.signal }))
    expect(abortedResponse.status).toBe(504)
    expect(abortCalls).toBe(1)
    await aborting.registry.dispose()
  })
})
