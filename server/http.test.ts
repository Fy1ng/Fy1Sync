import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  clientIsLoopback,
  isSameOriginRequest,
  matchPattern,
  matchRoute,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  requestUrl,
  type Route,
} from './http'

/**
 * A readable stream carrying the headers `readJsonBody` inspects. The real `destroy` is
 * kept: stubbing it stalls `for await`, which waits on the close that never comes.
 */
function fakeRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const chunks = body.length > 0 ? [Buffer.from(body, 'utf8')] : []
  const stream = Readable.from(chunks) as unknown as IncomingMessage
  stream.headers = { 'content-length': String(Buffer.byteLength(body)), ...headers }
  return stream
}

describe('matchPattern', () => {
  it('matches an exact path', () => {
    expect(matchPattern('/api/health', '/api/health')).toEqual({})
    expect(matchPattern('/api/health', '/api/healthz')).toBeNull()
  })

  it('extracts named params and decodes them', () => {
    expect(matchPattern('/api/danmaku/douyu/:room', '/api/danmaku/douyu/288016')).toEqual({
      room: '288016',
    })
    expect(matchPattern('/api/x/:name', '/api/x/a%2Fb')).toEqual({ name: 'a/b' })
  })

  it('rejects a shorter or longer path', () => {
    expect(matchPattern('/api/a/:b', '/api/a')).toBeNull()
    expect(matchPattern('/api/a/:b', '/api/a/b/c')).toBeNull()
  })

  it('captures a subtree with a trailing wildcard', () => {
    expect(matchPattern('/api/presets/*', '/api/presets/cs2/iem')).toEqual({ rest: 'cs2/iem' })
    expect(matchPattern('/api/presets/*', '/api/presets/one')).toEqual({ rest: 'one' })
  })

  it('treats trailing slashes as absent segments', () => {
    expect(matchPattern('/api/health', '/api/health/')).toEqual({})
  })
})

describe('matchRoute', () => {
  const routes: Route[] = [
    { method: 'GET', pattern: '/api/presets', handler: () => 'list' as unknown as void },
    { method: 'GET', pattern: '/api/presets/*', handler: () => 'get' as unknown as void },
    { method: 'PUT', pattern: '/api/presets/*', handler: () => 'put' as unknown as void },
  ]

  it('prefers the earlier route when two patterns overlap', () => {
    expect(matchRoute(routes, 'GET', '/api/presets')?.route.pattern).toBe('/api/presets')
    expect(matchRoute(routes, 'GET', '/api/presets/cs2/iem')?.route.pattern).toBe('/api/presets/*')
  })

  it('dispatches on method', () => {
    expect(matchRoute(routes, 'PUT', '/api/presets/x')?.route.pattern).toBe('/api/presets/*')
    expect(matchRoute(routes, 'DELETE', '/api/presets/x')).toBeNull()
  })

  it('serves HEAD from a GET route', () => {
    expect(matchRoute(routes, 'HEAD', '/api/presets')?.route.method).toBe('GET')
  })

  it('returns null for an unknown path', () => {
    expect(matchRoute(routes, 'GET', '/api/nope')).toBeNull()
  })
})

describe('requestUrl', () => {
  it('builds an absolute URL from the Host header', () => {
    const req = { url: '/api/proxy?url=https%3A%2F%2Fa.example%2Fx', headers: { host: 'localhost:5178' } } as IncomingMessage
    const url = requestUrl(req)
    expect(url.pathname).toBe('/api/proxy')
    expect(url.searchParams.get('url')).toBe('https://a.example/x')
  })

  it('falls back to loopback when Host is missing', () => {
    expect(requestUrl({ url: '/x', headers: {} } as IncomingMessage).host).toBe('127.0.0.1')
  })
})

describe('readJsonBody', () => {
  it('parses a JSON object', async () => {
    const result = await readJsonBody(fakeRequest('{"a":1}'))
    expect(result).toEqual({ ok: true, value: { a: 1 } })
  })

  it('returns undefined for an empty body', async () => {
    expect(await readJsonBody(fakeRequest(''))).toEqual({ ok: true, value: undefined })
  })

  it('reports invalid JSON', async () => {
    const result = await readJsonBody(fakeRequest('{oops'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-json')
  })

  it('rejects an over-limit body from the declared content-length', async () => {
    const result = await readJsonBody(fakeRequest('{}', { 'content-length': '99999999' }), 10)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('too-large')
  })

  it('rejects an over-limit body that lied about its length', async () => {
    // A truthful content-length is not required, so the cap is also enforced mid-stream.
    const req = fakeRequest('x'.repeat(64), { 'content-length': '2' })
    const result = await readJsonBody(req, 16)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('too-large')
  })

  it('defaults to a 1 MiB cap', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(1_048_576)
  })
})

describe('isSameOriginRequest', () => {
  const req = (headers: Record<string, string>) => ({ headers } as IncomingMessage)

  it('trusts Sec-Fetch-Site when present', () => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'none' }))).toBe(true)
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('ignores a matching Origin when Sec-Fetch-Site says cross-site', () => {
    expect(
      isSameOriginRequest(
        req({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:5178', host: '127.0.0.1:5178' }),
      ),
    ).toBe(false)
  })

  it('compares Origin against Host when Sec-Fetch-Site is absent', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:5178', host: '127.0.0.1:5178' }))).toBe(true)
    expect(isSameOriginRequest(req({ origin: 'https://evil.example', host: '127.0.0.1:5178' }))).toBe(false)
  })

  it('treats a port mismatch as cross-origin', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:5178' }))).toBe(false)
  })

  it('allows a non-browser client that sends no Origin', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:5178' }))).toBe(true)
  })

  it('rejects a malformed Origin', () => {
    expect(isSameOriginRequest(req({ origin: '://', host: '127.0.0.1:5178' }))).toBe(false)
  })
})

describe('clientIsLoopback', () => {
  const req = (remoteAddress: string) => ({ socket: { remoteAddress } } as IncomingMessage)

  it('accepts loopback in v4, v6 and v4-mapped form', () => {
    expect(clientIsLoopback(req('127.0.0.1'))).toBe(true)
    expect(clientIsLoopback(req('::1'))).toBe(true)
    expect(clientIsLoopback(req('::ffff:127.0.0.1'))).toBe(true)
    expect(clientIsLoopback(req('127.5.5.5'))).toBe(true)
  })

  it('rejects a LAN or public address', () => {
    expect(clientIsLoopback(req('192.168.1.20'))).toBe(false)
    expect(clientIsLoopback(req('8.8.8.8'))).toBe(false)
    expect(clientIsLoopback(req(''))).toBe(false)
  })
})
