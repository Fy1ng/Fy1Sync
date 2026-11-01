import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkPolicy, installNetworkPolicy } from '../server/networkPolicy'
import { isPublicUpdateAddress, readUpdateDownload, streamUpdateDownload } from './updateDownload'

const url = 'https://updates.example.org/file.json'
const options = () => ({ signal: new AbortController().signal, limit: 1024, resolve: async () => ['93.184.216.34'] })
afterEach(() => {
  vi.useRealTimers()
  installNetworkPolicy(new NetworkPolicy(async () => 'DIRECT', () => 'direct'))
})

describe('executable update downloads', () => {
  it('omits credentials, revalidates caches and uses a manual redirect transport', async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response('abc', { headers: { 'content-length': '3' } }))
    expect((await readUpdateDownload(url, { ...options(), expectedBytes: 3, request })).toString()).toBe('abc')
    const init = request.mock.calls[0]?.[1]
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store', headers: { 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' } })
    expect(init?.headers).not.toHaveProperty('Cookie')
    expect(init?.headers).not.toHaveProperty('Authorization')
  })

  it.each(['0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.31.255.255', '192.168.1.5', '192.0.2.1', '198.19.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '3fff::1', '3fff:fff::1', '2002:7f00:1::', 'invalid-address'])('refuses non-public DNS address %s before any request', async address => {
    expect(isPublicUpdateAddress(address)).toBe(false)
    const request = vi.fn()
    await expect(readUpdateDownload(url, { ...options(), resolve: async () => [address], request })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('validates every DNS answer, including mixed public/private answers', async () => {
    expect(isPublicUpdateAddress('93.184.216.34')).toBe(true)
    expect(isPublicUpdateAddress('2606:4700:4700::1111')).toBe(true)
    expect(isPublicUpdateAddress('2001:4860:4860::8888')).toBe(true)
    const request = vi.fn()
    await expect(readUpdateDownload(url, { ...options(), resolve: async () => ['93.184.216.34', '127.0.0.1'], request })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })

  it('does not bypass the public-address guard when using the configured HTTP proxy', async () => {
    const route = vi.fn(async () => 'PROXY 127.0.0.1:8080')
    installNetworkPolicy(new NetworkPolicy(route, () => 'system'))
    const request = vi.fn(async () => new Response('abc'))
    await expect(readUpdateDownload(url, { ...options(), resolve: async () => ['10.0.0.1'], request })).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    expect(route).not.toHaveBeenCalled()
    expect((await readUpdateDownload(url, { ...options(), request })).toString()).toBe('abc')
    expect(route).toHaveBeenCalledOnce()
  })

  it('never redirects catalogs or frontend containers', async () => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/other.json' } }))
    await expect(readUpdateDownload(url, { ...options(), request })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('permits only signed installer redirect origins and validates every hop', async () => {
    const request = vi.fn(async (input: Parameters<typeof fetch>[0]) => String(input) === url
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/install.exe?public=signature' } })
      : new Response('abc'))
    expect((await readUpdateDownload(url, { ...options(), request, redirectOrigins: ['https://cdn.example.org'] })).toString()).toBe('abc')
    expect(request).toHaveBeenCalledTimes(2)
    request.mockClear()
    await expect(readUpdateDownload(url, { ...options(), request, redirectOrigins: [] })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
    request.mockClear()
    await expect(readUpdateDownload(url, { ...options(), request, redirectOrigins: ['https://cdn.example.org'], resolve: async host => host === 'cdn.example.org' ? ['192.168.1.1'] : ['93.184.216.34'] })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['http://cdn.example.org/install.exe', 'https://name:secret@cdn.example.org/install.exe', 'https://cdn.example.org:8443/install.exe', 'https://other.example.org/install.exe', 'https://127.0.0.1/install.exe'])('refuses unsafe redirect %s', location => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
    return expect(readUpdateDownload(url, { ...options(), request, redirectOrigins: ['https://cdn.example.org'] })).rejects.toThrow()
  })

  it('bounds redirect loops', async () => {
    const request = vi.fn(async () => new Response(null, { status: 302, headers: { location: url } }))
    await expect(readUpdateDownload(url, { ...options(), request, redirectOrigins: [] })).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(5)
  })

  it.each(['redirected', 'url'])('rejects hidden transport redirection via %s', property => {
    const response = new Response('abc')
    Object.defineProperty(response, property, { value: property === 'redirected' ? true : 'https://evil.example.org/file' })
    return expect(readUpdateDownload(url, { ...options(), request: async () => response })).rejects.toThrow()
  })

  it.each([
    new Response('abcd', { headers: { 'content-length': '4' } }),
    new Response('abc', { headers: { 'content-length': '2' } }),
    new Response('abcd'), new Response('ab'), new Response('abc', { status: 206 }),
    new Response('abc', { headers: { 'content-encoding': 'gzip' } }),
    new Response('abc', { headers: { 'content-length': '-1' } }), new Response(''),
  ])('enforces exact byte lengths, identity encoding and full responses', response => {
    return expect(readUpdateDownload(url, { ...options(), limit: 3, expectedBytes: 3, request: async () => response })).rejects.toThrow()
  })

  it('stops a partial stream when cancelled without consuming further chunks', async () => {
    const controller = new AbortController(), consumed: string[] = [], cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('abc')) }, cancel })
    await expect(streamUpdateDownload(url, { ...options(), signal: controller.signal, request: async () => new Response(body) }, async bytes => {
      consumed.push(Buffer.from(bytes).toString())
      controller.abort()
    })).rejects.toThrow()
    expect(consumed).toEqual(['abc'])
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['request', 'dns', 'body'])('times out an uncooperative %s', async part => {
    vi.useFakeTimers()
    const request = async () => part === 'request' ? new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>())
    const pending = readUpdateDownload(url, { ...options(), request, resolve: part === 'dns' ? async () => new Promise<string[]>(() => {}) : options().resolve, timeoutMs: 100 })
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(101)
    await rejected
  })
})
