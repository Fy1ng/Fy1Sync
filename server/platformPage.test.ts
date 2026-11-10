import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResolverDeps } from './api'
import { resolveConfig } from './config'
import { MAX_PLATFORM_RESPONSE_BYTES } from './platformResponse'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
afterEach(() => vi.restoreAllMocks())

function fixture(fetchImpl: typeof fetch) {
  return createResolverDeps(resolveConfig({}).proxy, url => url, fetchImpl)
}

describe('bounded platform pages and share redirects', () => {
  it('returns the checked final address and anonymous session headers after a public share redirect', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input).startsWith('https://v.douyin.com/')) return new Response(null, {
        status: 302, headers: { location: 'https://live.douyin.com/100' },
      })
      const headers = new Headers()
      headers.append('set-cookie', 'ttwid=fixture; Path=/; Secure; HttpOnly')
      headers.append('set-cookie', 'UIFID_TEMP=fixture; Path=/; Secure')
      return new Response('<html>fixture</html>', { headers })
    })
    const page = await fixture(fetchImpl).fetchPage('https://v.douyin.com/Fixture/')
    expect(page).toEqual({ text: '<html>fixture</html>', finalUrl: 'https://live.douyin.com/100',
      setCookie: ['ttwid=fixture; Path=/; Secure; HttpOnly', 'UIFID_TEMP=fixture; Path=/; Secure'] })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('rejects a share redirect to an unapproved domain before sending another request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: 'https://unrelated.invalid/collect' },
    }))
    await expect(fixture(fetchImpl).fetchPage('https://v.douyin.com/Fixture/')).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not forward a cookie when a room page redirects to a different origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: 'https://webcast.amemv.com/webcast/reflow/100' },
    }))
    await expect(fixture(fetchImpl).fetchPage('https://live.douyin.com/100', {
      headers: { Cookie: 'ttwid=fixture' },
    })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('applies the metadata size bound to a live page', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x', {
      headers: { 'content-length': String(MAX_PLATFORM_RESPONSE_BYTES + 1) },
    }))
    await expect(fixture(fetchImpl).fetchPage('https://live.douyin.com/100')).rejects.toThrow()
  })
})
