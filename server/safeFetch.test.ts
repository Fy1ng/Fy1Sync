import { describe, expect, it } from 'vitest'
import { resolveConfig } from './config'
import { checkUrl, isPrivateAddress, safeFetch, ProxyError } from './safeFetch'

const proxyConfig = resolveConfig({}, '/tmp').proxy

/** Pretend every hostname resolves to a public address unless stated otherwise. */
const publicResolver = async () => ['93.184.216.34']

describe('isPrivateAddress', () => {
  const privateCases = [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '100.64.0.1', // CGNAT
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    // The URL parser canonicalises `[::ffff:127.0.0.1]` to this hex form, so the
    // embedded address has to be decoded, not matched as dotted text.
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', // cloud metadata, mapped
    '::7f00:1', // IPv4-compatible loopback
    '64:ff9b::7f00:1', // NAT64 loopback
    '0:0:0:0:0:0:0:1', // uncompressed ::1
    '2001:db8::1', // documentation range
  ]

  for (const address of privateCases) {
    it(`rejects ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(true)
    })
  }

  it('rejects the hex form the URL parser produces for a mapped loopback host', () => {
    const host = new URL('http://[::ffff:127.0.0.1]/').hostname.replace(/^\[|\]$/g, '')
    expect(host).toBe('::ffff:7f00:1')
    expect(isPrivateAddress(host)).toBe(true)
  })

  // 198.18.0.0/15 is where fake-IP proxies (Clash/mihomo TUN) map every domain; see safeFetch.ts.
  const publicCases = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:808:808', '198.18.0.37', '198.19.255.255']
  for (const address of publicCases) {
    it(`allows ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(false)
    })
  }
})

describe('checkUrl', () => {
  it('accepts an allow-listed host that resolves publicly', async () => {
    const result = await checkUrl(
      'https://video-edge-abc.ttvnw.net/v1/segment/x.ts',
      proxyConfig,
      publicResolver,
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a host outside the allow-list', async () => {
    const result = await checkUrl('https://evil.example.com/a.ts', proxyConfig, publicResolver)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('host-not-allowed')
  })

  it('rejects non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://usher.ttvnw.net/x', 'data:text/plain,hi']) {
      const result = await checkUrl(url, proxyConfig, publicResolver)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('bad-scheme')
    }
  })

  it('rejects a malformed URL', async () => {
    const result = await checkUrl('not a url', proxyConfig, publicResolver)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid-url')
  })

  it('rejects non-standard ports by default', async () => {
    const result = await checkUrl('https://usher.ttvnw.net:9001/x.m3u8', proxyConfig, publicResolver)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad-port')
  })

  it('allows non-standard ports when configured', async () => {
    const result = await checkUrl(
      'https://usher.ttvnw.net:9001/x.m3u8',
      { ...proxyConfig, allowNonStandardPorts: true },
      publicResolver,
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a host that resolves to a private address (DNS rebinding)', async () => {
    const result = await checkUrl('https://usher.ttvnw.net/x.m3u8', proxyConfig, async () => [
      '127.0.0.1',
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('private-address')
  })

  it('rejects when any resolved address is private', async () => {
    const result = await checkUrl('https://usher.ttvnw.net/x.m3u8', proxyConfig, async () => [
      '93.184.216.34',
      '169.254.169.254',
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('private-address')
  })

  it('reports DNS failure distinctly from a private address', async () => {
    const result = await checkUrl('https://usher.ttvnw.net/x.m3u8', proxyConfig, async () => {
      throw new Error('ENOTFOUND')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('dns-failed')
  })

  it.each([null, {}, [], ['not-an-address'], ['8.8.8.8', 42], Array.from({ length: 65 }, () => '8.8.8.8')])('rejects invalid or unbounded DNS records %#', async addresses => {
    const result = await checkUrl('https://usher.ttvnw.net/x', proxyConfig, async () => addresses as string[])
    expect(result).toMatchObject({ ok: false, reason: 'dns-failed' })
  })

  it('allows loopback targets when explicitly enabled (local fixtures)', async () => {
    const result = await checkUrl(
      'http://127.0.0.1:5173/test-sources/clock.m3u8',
      {
        ...proxyConfig,
        hosts: ['*'],
        allowNonStandardPorts: true,
        allowNonLoopbackTargets: true,
      },
      async () => ['127.0.0.1'],
    )
    expect(result.ok).toBe(true)
  })

  it('honours a wildcard host pattern but not the bare apex', async () => {
    const config = { ...proxyConfig, hosts: ['*.ttvnw.net'] }
    expect((await checkUrl('https://a.ttvnw.net/x', config, publicResolver)).ok).toBe(true)
    expect((await checkUrl('https://ttvnw.net/x', config, publicResolver)).ok).toBe(false)
    // A suffix match must not be a substring match.
    expect((await checkUrl('https://evilttvnw.net/x', config, publicResolver)).ok).toBe(false)
  })
})

describe('safeFetch', () => {
  it.each(['Cookie', 'authorization', 'Proxy-Authorization'])('does not forward %s across an origin redirect', async (header) => {
    let calls = 0
    await expect(safeFetch('https://usher.ttvnw.net/a', proxyConfig, {
      resolve: publicResolver, headers: { [header]: 'synthetic-private-value' },
      fetchImpl: async () => {
        calls++
        return new Response(null, { status: 302, headers: { location: 'https://video-weaver.ttvnw.net/b' } })
      },
    })).rejects.toBeInstanceOf(ProxyError)
    expect(calls).toBe(1)
  })

  it('keeps credentials on a validated same-origin redirect', async () => {
    let calls = 0
    const result = await safeFetch('https://usher.ttvnw.net/a', proxyConfig, {
      resolve: publicResolver, headers: { Cookie: 'synthetic-private-value' },
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('cookie')).toBe('synthetic-private-value')
        return ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/b' } }) : new Response('ok')
      },
    })
    expect(result.finalUrl.pathname).toBe('/b')
    expect(calls).toBe(2)
  })
  it('fetches an allowed URL and reports the final URL', async () => {
    const calls: string[] = []
    const { response, finalUrl } = await safeFetch('https://usher.ttvnw.net/a.m3u8', proxyConfig, {
      resolve: publicResolver,
      fetchImpl: async (input) => {
        calls.push(String(input))
        return new Response('#EXTM3U', { status: 200 })
      },
    })
    expect(response.status).toBe(200)
    expect(finalUrl.href).toBe('https://usher.ttvnw.net/a.m3u8')
    expect(calls).toEqual(['https://usher.ttvnw.net/a.m3u8'])
  })

  it('follows a redirect and revalidates the new hop', async () => {
    const seen: string[] = []
    const { response, finalUrl } = await safeFetch('https://usher.ttvnw.net/a.m3u8', proxyConfig, {
      resolve: publicResolver,
      fetchImpl: async (input) => {
        const url = String(input)
        seen.push(url)
        if (url.endsWith('/a.m3u8')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://video-weaver.ttvnw.net/b.m3u8' },
          })
        }
        return new Response('#EXTM3U', { status: 200 })
      },
    })
    expect(response.status).toBe(200)
    expect(finalUrl.href).toBe('https://video-weaver.ttvnw.net/b.m3u8')
    expect(seen).toHaveLength(2)
  })

  it('rejects a redirect that points at a private address', async () => {
    await expect(
      safeFetch('https://usher.ttvnw.net/a.m3u8', proxyConfig, {
        resolve: async (host) => (host === 'usher.ttvnw.net' ? ['93.184.216.34'] : ['127.0.0.1']),
        fetchImpl: async (input) =>
          String(input).endsWith('/a.m3u8')
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://video-weaver.ttvnw.net/internal' },
              })
            : new Response('should not be reached', { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(ProxyError)
  })

  it('rejects a redirect to a host outside the allow-list', async () => {
    const error = await safeFetch('https://usher.ttvnw.net/a.m3u8', proxyConfig, {
      resolve: publicResolver,
      fetchImpl: async () =>
        new Response(null, { status: 301, headers: { location: 'https://evil.example.com/x' } }),
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProxyError)
    expect((error as ProxyError).reason).toBe('host-not-allowed')
  })

  it('gives up after the configured redirect budget', async () => {
    let hop = 0
    const error = await safeFetch(
      'https://usher.ttvnw.net/0',
      { ...proxyConfig, maxRedirects: 2 },
      {
        resolve: publicResolver,
        fetchImpl: async () => {
          hop += 1
          return new Response(null, {
            status: 302,
            headers: { location: `https://usher.ttvnw.net/${hop}` },
          })
        },
      },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProxyError)
    expect((error as ProxyError).reason).toBe('too-many-redirects')
    expect(hop).toBe(3) // initial + 2 allowed redirects
  })

  it('throws ProxyError for a disallowed initial URL rather than fetching', async () => {
    let fetched = false
    await expect(
      safeFetch('https://evil.example.com/x', proxyConfig, {
        resolve: publicResolver,
        fetchImpl: async () => {
          fetched = true
          return new Response('')
        },
      }),
    ).rejects.toBeInstanceOf(ProxyError)
    expect(fetched).toBe(false)
  })
})
