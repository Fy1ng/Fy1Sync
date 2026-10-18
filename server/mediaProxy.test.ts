import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from './config'
import { MediaRegistry, type MediaDeps } from './mediaProxy'

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
  it('blocks hosts outside the allow list before fetch', async () => {
    const f = fixture()
    const url = f.registry.register('https://evil.example/a.mp4')
    expect((await f.registry.handle(request(url))).status).toBe(403)
    expect(f.calls).toHaveLength(0)
  })
  it('blocks private DNS results before fetch', async () => {
    const f = fixture(PLAYLIST, { resolve: async () => ['127.0.0.1'] })
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
    expect(text).toContain(f.registry.register('https://video-weaver.ttvnw.net/live/seg.ts'))
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text)))
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('uses the final redirect URL when registering relative segments', async () => {
    const f = fixture(PLAYLIST, { fetchImpl: (async (url) => String(url) === TARGET ? new Response(null, { status: 302, headers: { location: '/redirect/index.m3u8' } }) : new Response(PLAYLIST, { headers: { 'content-type': 'text/plain' } })) as typeof fetch })
    const text = await (await f.registry.handle(request(f.url))).text()
    expect(text).toContain(f.registry.register('https://video-weaver.ttvnw.net/redirect/seg.ts'))
  })
  it('rewrites opaque signed playlists labelled as octet-stream', async () => {
    const f = fixture(PLAYLIST, {}, { 'content-type': 'application/octet-stream' })
    const url = f.registry.register('https://video-weaver.ttvnw.net/v1/CvYE...signed')
    const text = await (await f.registry.handle(request(url))).text()
    expect(text).toContain(f.registry.register('https://video-weaver.ttvnw.net/v1/seg.ts'))
  })
  it('refuses unsafe URI schemes found in a playlist', async () => {
    const f = fixture('#EXTM3U\nfile:///secret\n')
    expect((await f.registry.handle(request(f.url))).status).toBe(502)
  })
  it('revalidates redirects to private addresses', async () => {
    const f = fixture(PLAYLIST, { config: { ...resolveConfig({}).proxy, hosts: ['*'] }, fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.ts' } })) as typeof fetch })
    expect((await f.registry.handle(request(f.url))).status).toBe(403)
  })
  it('preserves mislabelled binary bytes without text transcoding', async () => {
    const bytes = new Uint8Array([255,0,128,99])
    const f = fixture(bytes, {}, { 'content-type': 'application/vnd.apple.mpegurl' })
    expect(new Uint8Array(await (await f.registry.handle(request(f.url))).arrayBuffer())).toEqual(bytes)
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
})
