import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from './config'
import { handleProxyRequest, PROXY_PATH, type ProxyDeps } from './mediaProxy'
import type { Resolver } from './safeFetch'
import { asServerResponse, fakeResponse } from './testDoubles'

/** Every allow-listed host resolves to a public address, so SSRF checks pass. */
const publicResolver: Resolver = async () => ['93.184.216.34']

function proxyConfig(overrides: Record<string, unknown> = {}) {
  return { ...resolveConfig({}).proxy, ...overrides }
}

function fakeRequest(headers: Record<string, string> = {}, method = 'GET'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage
}

/** Records what the proxy asked upstream for, and answers with a canned response. */
function recordingFetch(response: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return response
  }) as typeof fetch
  return { fetchImpl, calls, get last() { return calls.at(-1)! } }
}

function deps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return { config: proxyConfig(), resolve: publicResolver, ...overrides }
}

const TARGET = 'https://video-weaver.ttvnw.net/v1/playlist/abc.m3u8'

function proxyUrl(target = TARGET): URL {
  const url = new URL(`http://127.0.0.1:5178${PROXY_PATH}`)
  url.searchParams.set('url', target)
  return url
}

const PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4.0,', 'seg-1.ts', ''].join('\n')

function playlistResponse(body = PLAYLIST, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.apple.mpegurl', ...headers },
  })
}

describe('handleProxyRequest guards', () => {
  it('refuses when the proxy is switched off', async () => {
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ config: proxyConfig({ enabled: false }) }))
    expect(res.status).toBe(503)
    expect(JSON.parse(res.body()).error.code).toBe('proxy-disabled')
  })

  it('rejects a request without a url parameter', async () => {
    const res = fakeResponse()
    const url = new URL(`http://127.0.0.1:5178${PROXY_PATH}`)
    await handleProxyRequest(fakeRequest(), asServerResponse(res), url, deps())
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body()).error.code).toBe('missing-url')
  })

  it('reports a blocked host as a ProxyError status, not a generic 502', async () => {
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl('https://evil.example.com/a.m3u8'), deps())
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body()).error.code).toBe('host-not-allowed')
  })

  it('never reaches fetch for a rejected target', async () => {
    const upstream = recordingFetch(playlistResponse())
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest(),
      asServerResponse(res),
      proxyUrl('http://169.254.169.254/latest/meta-data'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(upstream.calls).toHaveLength(0)
    expect(res.status).toBe(403)
  })
})

describe('handleProxyRequest header handling', () => {
  it('forwards range, accept, accept-encoding and if-none-match', async () => {
    const upstream = recordingFetch(new Response('x', { status: 206, headers: { 'content-type': 'video/mp2t' } }))
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest({
        range: 'bytes=100-199',
        accept: '*/*',
        'accept-encoding': 'gzip',
        'if-none-match': 'W/"abc"',
      }),
      asServerResponse(res),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    const sent = upstream.last.init.headers as Record<string, string>
    expect(sent.range).toBe('bytes=100-199')
    expect(sent.accept).toBe('*/*')
    expect(sent['accept-encoding']).toBe('gzip')
    expect(sent['if-none-match']).toBe('W/"abc"')
  })

  it('drops cookie, authorization and a client-supplied referer', async () => {
    // The reference implementation forwarded these to spoof platform checks; sending a
    // browser's cookies to an arbitrary allow-listed host is a credential leak.
    const upstream = recordingFetch(new Response('x', { status: 200, headers: { 'content-type': 'video/mp2t' } }))
    await handleProxyRequest(
      fakeRequest({
        cookie: 'auth=secret',
        authorization: 'Bearer token',
        referer: 'https://www.douyu.com/',
        origin: 'https://www.douyu.com',
      }),
      asServerResponse(fakeResponse()),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    const sent = upstream.last.init.headers as Record<string, string>
    expect(sent.cookie).toBeUndefined()
    expect(sent.authorization).toBeUndefined()
    expect(sent.referer).toBeUndefined()
    expect(sent.origin).toBeUndefined()
  })

  it('sends an honest user agent rather than a spoofed browser string', async () => {
    const upstream = recordingFetch(new Response('x', { status: 200, headers: { 'content-type': 'video/mp2t' } }))
    await handleProxyRequest(
      fakeRequest({ 'user-agent': 'Mozilla/5.0 (spoofed)' }),
      asServerResponse(fakeResponse()),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    const sent = upstream.last.init.headers as Record<string, string>
    expect(sent['user-agent']).toBe('StreamSyncPlayer/0.1 (+local)')
  })

  it('passes through only the allow-listed response headers', async () => {
    const upstream = recordingFetch(
      new Response('abc', {
        status: 206,
        headers: {
          'content-type': 'video/mp2t',
          'content-length': '3',
          'content-range': 'bytes 100-102/900',
          'accept-ranges': 'bytes',
          etag: '"seg"',
          'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
          'set-cookie': 'sess=leak',
          'access-control-allow-credentials': 'true',
          server: 'upstream-cdn',
        },
      }),
    )
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest({ range: 'bytes=100-102' }),
      asServerResponse(res),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(res.status).toBe(206)
    expect(res.sentHeaders['content-range']).toBe('bytes 100-102/900')
    expect(res.sentHeaders['accept-ranges']).toBe('bytes')
    expect(res.sentHeaders.etag).toBe('"seg"')
    expect(res.sentHeaders['set-cookie']).toBeUndefined()
    expect(res.sentHeaders.server).toBeUndefined()
    expect(res.sentHeaders['access-control-allow-credentials']).toBeUndefined()
    expect(res.sentHeaders['cache-control']).toBe('no-store')
  })
})

describe('handleProxyRequest playlist rewriting', () => {
  it('rewrites segment URIs through the proxy and declares the playlist type', async () => {
    const upstream = recordingFetch(playlistResponse())
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(res.status).toBe(200)
    const body = res.body()
    expect(body).toContain(`${PROXY_PATH}?url=`)
    expect(body).toContain(encodeURIComponent('https://video-weaver.ttvnw.net/v1/playlist/seg-1.ts'))
    expect(res.sentHeaders['content-type']).toBe('application/vnd.apple.mpegurl; charset=utf-8')
  })

  it('never caches a playlist, because a live one changes every few seconds', async () => {
    const upstream = recordingFetch(playlistResponse())
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(res.sentHeaders['cache-control']).toBe('no-store')
  })

  it('sets content-length from the rewritten body, not the upstream one', async () => {
    const upstream = recordingFetch(playlistResponse(PLAYLIST, { 'content-length': String(PLAYLIST.length) }))
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(Number(res.sentHeaders['content-length'])).toBe(Buffer.byteLength(res.body()))
    expect(Number(res.sentHeaders['content-length'])).toBeGreaterThan(PLAYLIST.length)
  })

  it('resolves relative URIs against the final URL after a redirect', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://video-edge.ttvnw.net/live/hi/index.m3u8' },
        })
      }
      return playlistResponse()
    }) as typeof fetch
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl }))
    expect(res.body()).toContain(encodeURIComponent('https://video-edge.ttvnw.net/live/hi/seg-1.ts'))
  })

  it('hands back an unmodified body when the content is not really a playlist', async () => {
    // Content type says playlist, body says otherwise. Line-rewriting binary would corrupt it.
    const upstream = recordingFetch(
      new Response('not a playlist at all', {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    )
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(res.body()).toBe('not a playlist at all')
    expect(res.sentHeaders['content-type']).toBe('application/vnd.apple.mpegurl')
  })

  it('streams a segment through without reading it as text', async () => {
    const payload = Buffer.from([0x47, 0x40, 0x00, 0x10, 0x00, 0xff])
    const upstream = recordingFetch(
      new Response(payload, { status: 200, headers: { 'content-type': 'video/mp2t' } }),
    )
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest(),
      asServerResponse(res),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(Buffer.from(res.body(), 'binary').length).toBeGreaterThan(0)
    expect(res.sentHeaders['content-type']).toBe('video/mp2t')
  })

  it('does not buffer a response larger than the playlist cap', async () => {
    const upstream = recordingFetch(
      new Response('#EXTM3U\nseg.ts\n', {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'content-length': String(8 * 1_048_576),
        },
      }),
    )
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    // Streamed verbatim: a 8 MiB "playlist" is a mislabelled asset, not something to rewrite.
    expect(res.body()).toBe('#EXTM3U\nseg.ts\n')
    expect(res.sentHeaders['content-type']).toBe('application/vnd.apple.mpegurl')
  })

  it('leaves an upstream error status alone instead of rewriting its body', async () => {
    const upstream = recordingFetch(
      new Response('#EXTM3U\nseg.ts\n', {
        status: 404,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      }),
    )
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(res.status).toBe(404)
    expect(res.body()).not.toContain(PROXY_PATH)
  })
})

describe('handleProxyRequest method handling', () => {
  it('issues HEAD upstream and returns no body', async () => {
    const upstream = recordingFetch(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'video/mp2t', 'content-length': '900', 'accept-ranges': 'bytes' },
      }),
    )
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest({}, 'HEAD'),
      asServerResponse(res),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(upstream.last.init.method).toBe('HEAD')
    expect(res.body()).toBe('')
    expect(res.sentHeaders['content-length']).toBe('900')
  })

  it('does not rewrite on HEAD even for a playlist URL', async () => {
    const upstream = recordingFetch(playlistResponse())
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest({}, 'HEAD'),
      asServerResponse(res),
      proxyUrl(),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(res.body()).toBe('')
  })
})

describe('handleProxyRequest failure paths', () => {
  it('reports a timeout as 504 once the abort fires', async () => {
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      // Wait for the proxy's own timeout to abort us, exactly as a stalled CDN would.
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as typeof fetch
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest(),
      asServerResponse(res),
      proxyUrl(),
      deps({ config: proxyConfig({ requestTimeoutMs: 20 }), fetchImpl }),
    )
    expect(res.status).toBe(504)
    expect(JSON.parse(res.body()).error.code).toBe('upstream-timeout')
  })

  it('reports a transport failure as 502 with the reason attached', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl }))
    expect(res.status).toBe(502)
    const payload = JSON.parse(res.body()).error
    expect(payload.code).toBe('upstream-failed')
    expect(payload.message).toContain('ECONNREFUSED')
  })

  it('destroys the socket instead of writing a second header block mid-stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('upstream reset'))
      },
    })
    const upstream = recordingFetch(
      new Response(body, { status: 200, headers: { 'content-type': 'video/mp2t' } }),
    )
    const res = fakeResponse()
    await handleProxyRequest(
      fakeRequest(),
      asServerResponse(res),
      proxyUrl('https://video-edge.ttvnw.net/seg-1.ts'),
      deps({ fetchImpl: upstream.fetchImpl }),
    )
    expect(res.status).toBe(200)
    expect(res.destroyCount).toBeGreaterThan(0)
  })

  it('aborts the upstream request when the client hangs up', async () => {
    let aborted = false
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      // The hang-up may land before fetch is even entered, so the already-aborted case
      // counts too; only checking the event would pass for the wrong reason.
      if (init.signal?.aborted) {
        aborted = true
        throw new Error('aborted')
      }
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    }) as typeof fetch
    const res = fakeResponse()
    const pending = handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl }))
    res.emit('close')
    await pending
    expect(aborted).toBe(true)
  })

  it('detaches its close listener so one response cannot leak per request', async () => {
    const upstream = recordingFetch(playlistResponse())
    const res = fakeResponse()
    await handleProxyRequest(fakeRequest(), asServerResponse(res), proxyUrl(), deps({ fetchImpl: upstream.fetchImpl }))
    expect(res.listenerCount('close')).toBe(0)
  })
})
