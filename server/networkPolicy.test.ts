import { describe, expect, it, vi } from 'vitest'
import { NetworkPolicy, parseProxyResult, type DomesticRouting } from './networkPolicy'

describe('system proxy route policy', () => {
  it.each([
    ['DIRECT', { kind: 'direct' }],
    ['PROXY 127.0.0.1:3128; DIRECT', { kind: 'http', proxyUrl: 'http://127.0.0.1:3128/' }],
    ['HTTP proxy.invalid:8080', { kind: 'http', proxyUrl: 'http://proxy.invalid:8080/' }],
    ['HTTPS proxy.invalid:443', { kind: 'http', proxyUrl: 'https://proxy.invalid/' }],
    ['SOCKS5 127.0.0.1:1080', { kind: 'direct', reason: 'socks-unsupported' }],
    ['SOCKS 127.0.0.1:1080; PROXY 127.0.0.1:3128', { kind: 'direct', reason: 'socks-unsupported' }],
    ['unknown value', { kind: 'direct', reason: 'proxy-type-unsupported' }],
  ])('parses Chromium result %s', (value, route) => {
    expect(parseProxyResult(value)).toEqual(route)
  })

  it('evaluates PAC by the complete target URL, including a distinct media CDN', async () => {
    const resolve = vi.fn(async url => url.startsWith('https://www.youtube.com/') ? 'PROXY 127.0.0.1:3128' : 'DIRECT')
    const policy = new NetworkPolicy(resolve, () => 'direct')
    const context = policy.context('youtube')
    expect(await context.route('https://www.youtube.com/watch?v=fixture')).toMatchObject({ kind: 'http' })
    expect(await context.route('https://rr1.googlevideo.com/videoplayback?fixture=1')).toEqual({ kind: 'direct' })
    expect(resolve.mock.calls.map(call => call[0])).toEqual([
      'https://www.youtube.com/watch?v=fixture', 'https://rr1.googlevideo.com/videoplayback?fixture=1',
    ])
  })

  it.each(['douyu', 'bilibili', 'huya'] as const)('keeps %s API, media CDN and sockets direct unless configured to follow the system', async platform => {
    let mode: DomesticRouting = 'direct'
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:3128')
    const policy = new NetworkPolicy(resolve, () => mode)
    const urls = [`https://api.${platform}.com/room`, 'https://platform-owned-cdn.invalid/live.flv', `wss://chat.${platform}.com/socket`]
    const direct = policy.context(platform)
    for (const url of urls) expect(await direct.route(url)).toEqual({ kind: 'direct' })
    expect(resolve).not.toHaveBeenCalled()
    mode = 'system'
    const system = policy.context(platform)
    for (const url of urls) expect(await system.route(url)).toMatchObject({ kind: 'http' })
    // A preference change applies to a new acquisition, never half of an existing one.
    for (const url of urls) expect(await direct.route(url)).toEqual({ kind: 'direct' })
    expect(resolve).toHaveBeenCalledTimes(urls.length)
  })

  it.each(['youtube', 'twitch'] as const)('follows system proxy by default for %s', async platform => {
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:3128')
    expect(await new NetworkPolicy(resolve, () => 'direct').context(platform).route(`https://www.${platform}.com/live`))
      .toMatchObject({ kind: 'http' })
  })

  it('applies domestic domain defaults when no platform is attached', async () => {
    const resolve = vi.fn(async () => 'PROXY 127.0.0.1:3128')
    const context = new NetworkPolicy(resolve, () => 'direct').context()
    for (const url of ['https://www.douyu.com/', 'https://cdn.douyucdn2.cn/live', 'https://api.live.bilibili.com/',
      'https://cdn.bilivideo.com/live', 'https://www.huya.com/', 'https://cdn.msstatic.com/live']) {
      expect(await context.route(url)).toEqual({ kind: 'direct' })
    }
    expect(await context.route('https://evil-douyu.com/')).toMatchObject({ kind: 'http' })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('shares short cache entries, expires new acquisitions, and preserves active URL decisions across retries', async () => {
    let now = 0, result = 'PROXY 127.0.0.1:3128'
    const resolve = vi.fn(async () => result)
    const policy = new NetworkPolicy(resolve, () => 'system', () => now, 1000)
    const url = 'https://cdn.fixture.invalid/live'
    const original = policy.context('youtube')
    expect(await original.route(url)).toMatchObject({ proxyUrl: 'http://127.0.0.1:3128/' })
    expect(await policy.context('youtube').route(url)).toMatchObject({ kind: 'http' })
    expect(resolve).toHaveBeenCalledTimes(1)
    result = 'DIRECT'; now = 1001
    expect(await original.route(url)).toMatchObject({ kind: 'http' })
    expect(await policy.context('youtube').route(url)).toEqual({ kind: 'direct' })
    expect(resolve).toHaveBeenCalledTimes(2)
    result = 'PROXY 127.0.0.1:8080'
    policy.invalidate()
    expect(await policy.context('youtube').route(url)).toMatchObject({ proxyUrl: 'http://127.0.0.1:8080/' })
    expect(await original.route(url)).toMatchObject({ proxyUrl: 'http://127.0.0.1:3128/' })
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('does not retain a failed system lookup in the shared cache', async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new Error('fixture')).mockResolvedValue('DIRECT')
    const policy = new NetworkPolicy(resolve, () => 'system')
    await expect(policy.context('twitch').route('https://gql.twitch.tv/')).rejects.toMatchObject({ failure: { stage: 'proxy', code: 'proxy-resolution-failed' } })
    expect(await policy.context('twitch').route('https://gql.twitch.tv/')).toEqual({ kind: 'direct' })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('reports a PAC summary when targets take different route types', async () => {
    const policy = new NetworkPolicy(async url => url.includes('youtube') ? 'PROXY 127.0.0.1:3128' : 'DIRECT', () => 'direct')
    expect(await policy.summary()).toEqual({ type: 'PAC' })
  })

  it('reports SOCKS fallback without disclosing the proxy endpoint', async () => {
    const policy = new NetworkPolicy(async () => 'SOCKS5 private-user:private-pass@127.0.0.1:1080', () => 'system')
    const summary = await policy.summary()
    expect(summary).toEqual({ type: 'SOCKS', fallbackReason: 'socks-unsupported' })
    expect(JSON.stringify(summary)).not.toMatch(/private-user|private-pass|127\.0\.0\.1|1080/)
  })
})
