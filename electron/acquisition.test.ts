import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { BufferInput, BufferState } from './bufferManager'
import { Acquisition } from './acquisition'
import { resolveConfig } from '../server/config'
import { createDesktopService } from '../server/api'
import * as platformResolvers from '../server/platforms'
import adaptiveFixture from '../server/platforms/fixtures/youtube-adaptive-live.json'
import type { LoginPlatform, LoginStatus } from './login'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))

function harness(overrides: Partial<ConstructorParameters<typeof Acquisition>[0]> = {}) {
  const listeners = new Set<(state: BufferState) => void>()
  const inputs: BufferInput[] = []
  let resolver: ((hlsOnly?: boolean) => Promise<BufferInput>) | undefined
  const emit = (state: BufferState) => { for (const listener of listeners) listener(state) }
  const buffer = {
    subscribe: (listener: (state: BufferState) => void) => {
      listeners.add(listener)
      listener({ role: 'official', state: 'ready', hasVideo: true, completeSegments: 1, seconds: 99 })
      return () => { listeners.delete(listener) }
    },
    start: vi.fn(async (role, prepare) => {
      resolver = prepare
      emit({ role, state: 'starting', seconds: 0 })
      inputs.push(await prepare())
      emit({ role, state: 'ready', hasVideo: true, completeSegments: 1, seconds: 6 })
      return { url: `app://app/buffer/session/${role}/generation/index.m3u8` }
    }),
    stop: vi.fn(async () => {}),
  }
  const logins = {
    cookieHeader: vi.fn(async (_platform: 'douyu' | 'bilibili' | 'huya' | 'douyin', _url?: string) => ''),
    login: vi.fn(async (_platform: LoginPlatform) => ({ cookieCount: 2, authKeysPresent: [] as string[] })),
    logout: vi.fn(async (_platform: LoginPlatform) => {}),
    loginStatus: vi.fn(async (): Promise<LoginStatus> => {
      const empty = { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false }
      return { youtube: { ...empty }, douyu: { ...empty }, bilibili: { ...empty }, huya: { ...empty }, douyin: { ...empty } }
    }),
  }
  const runYtDlp = vi.fn(async () => ({ is_live: true, id: 'abcdefghijk', live_status: 'is_live', formats: [
    { format_id: '301', protocol: 'm3u8_native', height: 1080, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/live.m3u8?signature=PRIVATE' },
    { format_id: '300', protocol: 'm3u8_native', height: 720, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/low.m3u8' },
  ] }))
  const proxy = { ...resolveConfig({}).proxy, hosts: ['*'] }
  const acquisition = new Acquisition({ buffer, logins, runYtDlp, proxy, dns: async () => ['8.8.8.8'], ...overrides })
  return { acquisition, buffer, logins, inputs, runYtDlp, proxy, emit, listeners,
    reconnect: async (hlsOnly?: boolean) => resolver!(hlsOnly) }
}

describe('main acquisition boundary', () => {
  it.each(['youtube', 'douyu', 'bilibili', 'huya'] as const)('supports %s login and logout through the validated service API', async platform => {
    const h = harness()
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition: h.acquisition })
    expect(await service.invoke('login', { platform })).toMatchObject({ ok: true, value: { cookieCount: 2 } })
    expect(h.logins.login).toHaveBeenCalledExactlyOnceWith(platform)
    expect(await service.invoke('logout', { platform })).toMatchObject({ ok: true, value: { ok: true } })
    expect(h.logins.logout).toHaveBeenCalledExactlyOnceWith(platform)
    expect(await service.invoke('loginStatus', undefined)).toMatchObject({ ok: true, value: { youtube: {}, douyu: {}, bilibili: {}, huya: {} } })
    for (const invalid of ['twitch', 'direct', 'huya.com', '../bilibili']) expect(await service.invoke('login', { platform: invalid })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    service.dispose()
  })

  it('passes Huya headers without probing signed media and re-resolves every reconnect, quality switch and restart', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('Signed media must not be preconnected') })
    const h = harness({ fetchImpl })
    let sequence = 0
    const resolve = vi.spyOn(platformResolvers, 'resolveStream').mockImplementation(async (_input, deps, platform) => {
      expect(platform).toBe('huya')
      sequence++
      return { ok: true, stream: { platform: 'huya', channel: '660000', sourceRoom: '660000', kind: 'progressive',
        url: `https://cdn-${sequence}.example/live.flv?wsSecret=PRIVATE_${sequence}&codec=264&ratio=${deps.quality ?? '0'}`,
        headers: { Referer: 'https://www.huya.com/', 'User-Agent': 'Huya test player' },
        quality: deps.quality ?? '0', qualities: [{ id: '0', label: '原画' }, { id: '8000', label: '蓝光' }],
        label: '虎牙 660000', requiresProxy: true } }
    })
    try {
      const first = await h.acquisition.resolve('huya.com/alias', 'huya', 'official')
      expect(first).toMatchObject({ ok: true, stream: { platform: 'huya', kind: 'hls', quality: '0' } })
      expect(JSON.stringify(first)).not.toMatch(/PRIVATE|cdn-|Referer|User-Agent|danmakuRoom/)
      expect(h.inputs[0]).toMatchObject({ url: expect.stringContaining('PRIVATE_1'),
        headers: { Referer: 'https://www.huya.com/', 'User-Agent': 'Huya test player' } })
      const second = await h.reconnect()
      expect(second.url).toContain('PRIVATE_2')
      expect(second.url).not.toBe(h.inputs[0]!.url)
      expect(second.headers).toMatchObject({ Referer: 'https://www.huya.com/' })
      expect(await h.acquisition.switchQuality('official', '8000')).toMatchObject({ ok: true, stream: { quality: '8000' } })
      expect(h.inputs.at(-1)?.url).toContain('PRIVATE_3&codec=264&ratio=8000')
      expect(await h.acquisition.restart('official')).toMatchObject({ ok: true, stream: { quality: '8000' } })
      expect(h.inputs.at(-1)?.url).toContain('PRIVATE_4&codec=264&ratio=8000')
      expect(resolve).toHaveBeenCalledTimes(4)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(h.logins.cookieHeader).not.toHaveBeenCalled()
      expect(h.runYtDlp).not.toHaveBeenCalled()
    } finally { resolve.mockRestore(); h.acquisition.dispose() }
  })

  it('buffers the highest Twitch rendition from a low-first master and selects again after reconnect', async () => {
    const requests: string[] = []
    let second = false
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input); requests.push(url)
      if (url === 'https://gql.twitch.tv/gql') return Response.json({ data: { streamPlaybackAccessToken: { value: 'PRIVATE_TOKEN', signature: 'PRIVATE_SIG' } } })
      if (url.startsWith('https://usher.ttvnw.net/')) return new Response(null, { status: 302, headers: { Location: 'https://video.ttvnw.net/redirected/master.m3u8' } })
      const variants = [
        '#EXT-X-STREAM-INF:BANDWIDTH=10000000,CODECS="mp4a.40.2"\naudio.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480,FRAME-RATE=30,CODECS="avc1.4D401E,mp4a.40.2"\nlow.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.64002A,mp4a.40.2"\nhigh.m3u8?signature=PRIVATE_' + (second ? 'NEW' : 'FIRST'),
      ]
      return new Response('#EXTM3U\n' + (second ? variants.reverse() : variants).join('\n'))
    })
    const h = harness({ fetchImpl })
    const result = await h.acquisition.resolve('twitch.tv/pgl', 'twitch', 'official', undefined, true)
    expect(result).toMatchObject({ ok: true, stream: { platform: 'twitch', url: expect.stringContaining('app://app/buffer/') } })
    expect(h.inputs[0]?.url).toBe('https://video.ttvnw.net/redirected/high.m3u8?signature=PRIVATE_FIRST')
    expect(requests.some(url => new URL(url).searchParams.get('allow_source') === 'true')).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|ttvnw/)
    second = true
    expect((await h.reconnect()).url).toBe('https://video.ttvnw.net/redirected/high.m3u8?signature=PRIVATE_NEW')
    expect(h.runYtDlp).not.toHaveBeenCalled()
  })

  it.each(['https://video.ttvnw.net:8443/live.m3u8', 'https://video.ttvnw.net:8080/live.m3u8'])('accepts a non-standard Twitch rendition port for buffering: %s', async uri => {
    const h = harness({ fetchImpl: async input => String(input).includes('gql.twitch.tv')
      ? Response.json({ data: { streamPlaybackAccessToken: { value: 'PRIVATE', signature: 'PRIVATE' } } })
      : new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60\n' + uri),
    })
    expect(await h.acquisition.resolve('twitch.tv/pgl', 'twitch', 'official', undefined, true)).toMatchObject({ ok: true })
    expect(h.inputs[0]?.url).toBe(uri)
  })

  it('keeps adaptive video/audio URLs private while passing the preference and re-resolving the best HLS fallback', async () => {
    const h = harness()
    const metadata = await h.runYtDlp()
    metadata.formats.push(
      { format_id: '308', protocol: 'https', height: 1440, fps: 60, vcodec: 'vp9', acodec: 'none', ext: 'webm', url: 'https://rr1.googlevideo.com/videoplayback?signature=PRIVATE_VIDEO' } as typeof metadata.formats[number],
      { format_id: '140', protocol: 'https', height: 0, fps: 0, vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', url: 'https://rr1.googlevideo.com/videoplayback?signature=PRIVATE_AUDIO' } as typeof metadata.formats[number],
    )
    h.runYtDlp.mockResolvedValue(metadata)
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition: h.acquisition })
    expect(await service.invoke('resolve', { input: 'https://youtu.be/abcdefghijk', platform: 'youtube', role: 'official', preferAdaptive: 'yes' }))
      .toMatchObject({ ok: false, code: 'invalid-arguments' })
    const result = await service.invoke('resolve', { input: 'https://youtu.be/abcdefghijk', platform: 'youtube', role: 'official', preferAdaptive: true })
    expect(result).toMatchObject({ ok: true, value: { ok: true, stream: { quality: '308', url: expect.stringContaining('app://') } } })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|videoUrl|audioUrl/)
    expect(h.inputs[0]!.adaptive).toMatchObject({ height: 1440, videoUrl: expect.stringContaining('PRIVATE_VIDEO') })
    const fallback = await h.reconnect(true)
    expect(fallback.adaptive).toBeUndefined()
    expect(fallback.qualityHeight).toBe(1080)
    expect(h.runYtDlp).toHaveBeenCalledTimes(3)
    expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false, expect.any(Object))
    service.dispose()
  })

  it('buffers adaptive-only broadcasts privately and keeps HLS-only recovery from returning another adaptive pair', async () => {
    const runYtDlp = vi.fn(async () => ({ ...adaptiveFixture, formats: adaptiveFixture.formats.filter(format => format.protocol === 'https') }))
    const h = harness({ runYtDlp })
    const result = await h.acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official')
    expect(result).toMatchObject({ ok: true, stream: { quality: '248', url: expect.stringContaining('app://app/buffer/') } })
    expect(h.inputs[0]?.adaptive).toMatchObject({ height: 1080 })
    expect(JSON.stringify(result)).not.toMatch(/googlevideo|videoUrl|audioUrl|itag=/)
    expect((await h.reconnect()).adaptive).toMatchObject({ height: 1080 })
    await expect(h.reconnect(true)).rejects.toMatchObject({ failure: { code: 'needs-manual-url' } })
    expect(runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false, expect.any(Object))
    h.acquisition.dispose()
  })

  it('returns the actual HLS quality when adaptive fails during initial buffer readiness', async () => {
    const h = harness()
    const metadata = await h.runYtDlp()
    metadata.formats.push(
      { format_id: '308', protocol: 'https', height: 1440, fps: 60, vcodec: 'vp9', acodec: 'none', ext: 'webm', url: 'https://rr1.googlevideo.com/videoplayback?itag=308' } as typeof metadata.formats[number],
      { format_id: '140', protocol: 'https', height: 0, fps: 0, vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', url: 'https://rr1.googlevideo.com/videoplayback?itag=140' } as typeof metadata.formats[number],
    )
    h.runYtDlp.mockResolvedValue(metadata)
    h.buffer.start.mockImplementationOnce(async (role, prepare) => {
      await prepare(false)
      await prepare(true)
      h.emit({ role, state: 'ready', hasVideo: true, completeSegments: 1, seconds: 6 })
      return { url: 'app://app/buffer/fallback/index.m3u8' }
    })
    const result = await h.acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official', undefined, true)
    expect(result).toMatchObject({ ok: true, stream: { quality: '301' } })
    expect(JSON.stringify(result)).not.toMatch(/videoUrl|audioUrl/)
  })

  it('falls back to HLS when a previously advertised adaptive id disappears after token provider failure', async () => {
    const h = harness()
    const metadata = await h.runYtDlp()
    metadata.formats.push(
      { format_id: '308', protocol: 'https', height: 1440, fps: 60, vcodec: 'vp9', acodec: 'none', ext: 'webm', url: 'https://rr1.googlevideo.com/videoplayback?itag=308' } as typeof metadata.formats[number],
      { format_id: '140', protocol: 'https', height: 0, fps: 0, vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', url: 'https://rr1.googlevideo.com/videoplayback?itag=140' } as typeof metadata.formats[number],
    )
    h.runYtDlp.mockResolvedValueOnce(metadata)
    await h.acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official')
    const switched = await h.acquisition.switchQuality('official', '308')
    expect(switched).toMatchObject({ ok: true, stream: { quality: '301' } })
    expect(h.inputs.at(-1)).toMatchObject({ fallbackFromHeight: 1440, qualityHeight: 1080 })
    expect(h.inputs.at(-1)?.adaptive).toBeUndefined()
    expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false, expect.any(Object))
  })

  it('returns only a local playlist and quality metadata, never the signed input', async () => {
    const h = harness()
    const result = await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    expect(result).toMatchObject({ ok: true, stream: { kind: 'hls', url: expect.stringContaining('app://app/buffer/'), quality: '301' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(h.inputs[0]!.url).toContain('signature=PRIVATE')
    expect(h.listeners.size).toBe(0)
  })

  it('resolves again on reconnect and on each role quality change', async () => {
    const h = harness()
    await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    await h.reconnect()
    expect(h.runYtDlp).toHaveBeenCalledTimes(2)
    const result = await h.acquisition.switchQuality('official', '300')
    expect(result).toMatchObject({ ok: true, stream: { quality: '300' } })
    expect(h.inputs.at(-1)?.url).toContain('/low.m3u8')
    expect(h.runYtDlp).toHaveBeenCalledTimes(3)
  })

  it.each(['https://user:password@8.8.8.8/x.flv'])('rejects credential-bearing direct input %s before spawning', async (input) => {
    const h = harness()
    await expect(h.acquisition.resolve(input, 'direct', 'official')).rejects.toHaveProperty('reason')
    expect(h.buffer.start).not.toHaveBeenCalled()
  })
  it.each(['http://127.0.0.1:8000/x.mp4', 'https://custom.example:8080/x.m3u8', 'http://192.168.1.5:8080/live.flv'])('accepts explicitly selected custom and local media %s', async input => {
    const dns = vi.fn(async () => ['127.0.0.1'])
    const h = harness({ dns })
    expect(await h.acquisition.resolve(input, 'direct', 'official')).toMatchObject({ ok: true })
    expect(h.inputs[0]?.url).toBe(input)
    expect(dns).not.toHaveBeenCalled()
  })

  it('routes direct FLV through ffmpeg and stops the producer for a local fixture', async () => {
    const h = harness()
    expect(await h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'commentary')).toMatchObject({ ok: true, stream: { kind: 'hls' } })
    await h.acquisition.resolve('/test-sources/official.mp4', 'direct', 'commentary')
    expect(h.buffer.stop).toHaveBeenCalledWith('commentary')
    expect(h.buffer.start).toHaveBeenCalledTimes(1)
    expect((await h.acquisition.switchQuality('commentary', '0')).ok).toBe(false)
  })

  it('cancels a slow source resolution when the role is unloaded', async () => {
    const h = harness()
    let complete!: (value: unknown) => void
    h.runYtDlp.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }) as any)
    const operation = h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    await vi.waitFor(() => expect(h.runYtDlp).toHaveBeenCalledTimes(1))
    await h.acquisition.stop('official')
    complete({ is_live: true, formats: [] })
    expect((await operation).ok).toBe(false)
    expect(h.buffer.start).not.toHaveBeenCalled()
  })

  it('waits for the new buffer rather than a replayed ready state from the old producer', async () => {
    const h = harness()
    let started = false
    h.buffer.start.mockImplementationOnce(async (_role, prepare) => {
      await prepare(); started = true
      return { url: 'app://app/buffer/new/index.m3u8' }
    })
    let finished = false
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official').then((value) => { finished = true; return value })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(finished).toBe(false)
    h.emit({ role: 'official', state: 'ready', hasVideo: true, completeSegments: 1, seconds: 6 })
    expect((await operation).ok).toBe(true)
  })

  it('does not publish a source on a premature ready event with less than four seconds', async () => {
    const h = harness()
    let started = false
    h.buffer.start.mockImplementationOnce(async (_role, prepare) => {
      await prepare(); started = true
      h.emit({ role: 'official', state: 'ready', hasVideo: true, completeSegments: 1, seconds: 0.033333 })
      return { url: 'app://app/buffer/partial/index.m3u8' }
    })
    let finished = false
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official').then(value => { finished = true; return value })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(finished).toBe(false)
    h.emit({ role: 'official', state: 'ready', hasVideo: true, completeSegments: 1, seconds: 4 })
    expect((await operation).ok).toBe(true)
  })

  it.each([true, false])('allows a previously offered adaptive option after automatic fallback, provider recovered=%s', async recovered => {
    const h = harness()
    const hls = await h.runYtDlp()
    const metadata = { ...hls, formats: [...hls.formats,
      { format_id: '308', protocol: 'https', height: 1440, fps: 60, vcodec: 'vp9', acodec: 'none', ext: 'webm', url: 'https://rr1.googlevideo.com/videoplayback?itag=308' },
      { format_id: '140', protocol: 'https', height: 0, fps: 0, vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a', url: 'https://rr1.googlevideo.com/videoplayback?itag=140' },
    ] }
    h.runYtDlp.mockResolvedValue(metadata)
    await h.acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official', undefined, true)
    h.runYtDlp.mockResolvedValue(hls)
    await h.reconnect(true)
    if (recovered) h.runYtDlp.mockResolvedValue(metadata)
    const retried = await h.acquisition.switchQuality('official', '308')
    expect(retried).toMatchObject({ ok: true, stream: { quality: recovered ? '308' : '301',
      qualities: expect.arrayContaining([expect.objectContaining({ id: '308', adaptive: true })]) } })
    expect(Boolean(h.inputs.at(-1)?.adaptive)).toBe(recovered)
    if (!recovered) expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false, expect.any(Object))
    expect((await h.acquisition.switchQuality('official', 'unoffered-id')).ok).toBe(false)
    expect(JSON.stringify(retried)).not.toMatch(/videoUrl|audioUrl|googlevideo/)
  })

  it('keeps the previous producer reconnectable when a replacement fails resolution', async () => {
    const h = harness()
    await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    h.runYtDlp.mockRejectedValueOnce(new Error('upstream failed'))
    expect((await h.acquisition.resolve('https://www.youtube.com/watch?v=klmnopqrstu', 'youtube', 'official')).ok).toBe(false)
    expect((await h.reconnect()).url).toContain('/live.m3u8')
  })

  it('validates login, quality and role arguments at the same main IPC boundary', async () => {
    const h = harness()
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition: h.acquisition })
    for (const [method, args] of [
      ['login', { platform: 'youtube', Cookie: 'PRIVATE' }], ['logout', { platform: '../../x' }],
      ['loginStatus', {}], ['switchQuality', { role: 'other', quality: '0' }],
      ['stopBuffer', { role: 'all' }], ['resolve', { input: 'x', role: '../official' }],
    ]) expect(await service.invoke(method, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(h.logins.login).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keeps existing safety and unsupported-input IPC contracts without requiring installed tools', async () => {
    const h = harness()
    const ensureTools = vi.fn(async () => { throw new Error('Tools must not be looked up') })
    const acquisition = new Acquisition({ buffer: h.buffer, logins: h.logins, runYtDlp: h.runYtDlp,
      proxy: h.proxy, dns: async () => ['8.8.8.8'], ensureTools })
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition })
    expect(await service.invoke('resolve', { input: 'not-a-stream-at-all' })).toMatchObject({ ok: true, value: { ok: false, failure: { code: 'unsupported-url' } } })
    expect(await service.invoke('resolve', { input: 'https://user:PRIVATE@custom.example/live', platform: 'direct' })).toMatchObject({ ok: false, code: 'invalid-url' })
    expect(ensureTools).not.toHaveBeenCalled()
    service.dispose()
  })
})


describe('domestic acquisition credential boundaries', () => {
  const biliPayload = { code: 0, data: { live_status: 1, playurl_info: { playurl: { stream: [{ protocol_name: 'http_hls', format: [{ format_name: 'ts', codec: [
    { codec_name: 'avc', current_qn: 150, accept_qn: [150], base_url: '/live.m3u8', url_info: [{ host: 'https://fixture.bilivideo.com' }] },
  ] }] }] } } } }
  const huyaPage = () => readFileSync(new URL('../server/platforms/fixtures/huya-live.html', import.meta.url), 'utf8')
  const entryUrl = (platform: 'bilibili' | 'huya') => platform === 'bilibili'
    ? 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=123456&protocol=0%2C1&format=0%2C1%2C2&codec=0%2C1&qn=150&platform=web&ptype=8'
    : 'https://www.huya.com/123456'

  it.each(['bilibili', 'huya'] as const)('passes %s credentials only to exact metadata URLs and refreshes them on reconnect', async platform => {
    const requests: Array<{ url: string; cookie: string | null }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, cookie: new Headers(init?.headers).get('Cookie') })
      if (url === 'https://wup.huya.com/') return new Response(new Uint8Array([0, 1, 2]))
      return platform === 'bilibili' ? Response.json(biliPayload) : new Response(huyaPage())
    })
    const mediaInput = vi.fn(async () => ({ url: 'http://127.0.0.1:4321/media/fixture', proxyUrl: '' }))
    const h = harness({ fetchImpl, mediaInput })
    h.logins.cookieHeader.mockResolvedValueOnce('fixture_session=first-ticket').mockResolvedValueOnce('fixture_session=second-ticket')
    const result = await h.acquisition.resolve('123456', platform, 'official', platform === 'bilibili' ? '150' : undefined)
    expect(result.ok).toBe(true)
    expect(h.logins.cookieHeader).toHaveBeenCalledExactlyOnceWith(platform, entryUrl(platform))
    expect(requests[0]).toEqual({ url: entryUrl(platform), cookie: 'fixture_session=first-ticket' })
    expect(JSON.stringify(result)).not.toMatch(/fixture_session|first-ticket|Cookie|SESSDATA|udb_biztoken/)
    expect(JSON.stringify(mediaInput.mock.calls)).not.toMatch(/fixture_session|first-ticket|Cookie/)
    expect(h.inputs[0]!.headers).toBeUndefined()
    await h.reconnect()
    expect(h.logins.cookieHeader).toHaveBeenNthCalledWith(2, platform, entryUrl(platform))
    expect(requests.filter(item => item.url === entryUrl(platform)).map(item => item.cookie)).toEqual(['fixture_session=first-ticket', 'fixture_session=second-ticket'])
    expect(requests.filter(item => item.url === 'https://wup.huya.com/').every(item => item.cookie === null)).toBe(true)
    expect(requests.every(item => item.url === entryUrl(platform) || item.url === 'https://wup.huya.com/')).toBe(true)
    expect(JSON.stringify(mediaInput.mock.calls)).not.toMatch(/fixture_session|first-ticket|second-ticket|Cookie/)
    expect(h.runYtDlp).not.toHaveBeenCalled()
    h.acquisition.dispose()
  })

  it.each(['bilibili', 'huya'] as const)('uses anonymous %s metadata when logout invalidates the cookie read', async platform => {
    const requests: Array<string | null> = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Headers(init?.headers).get('Cookie'))
      return platform === 'bilibili' ? Response.json(biliPayload) : new Response(huyaPage())
    })
    const h = harness({ fetchImpl })
    let finish!: (value: string) => void
    h.logins.cookieHeader.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = h.acquisition.resolve('123456', platform, 'official', platform === 'bilibili' ? '150' : undefined)
    expect(fetchImpl).not.toHaveBeenCalled()
    finish('')
    expect((await pending).ok).toBe(true)
    expect(requests.every(value => value === null)).toBe(true)
    expect(JSON.stringify(h.inputs)).not.toContain('Cookie')
    h.acquisition.dispose()
  })

  it.each(['bilibili', 'huya'] as const)('blocks cross-origin redirects for %s metadata carrying cookies', async platform => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://media-cdn.fixture.invalid/live' } }))
    const h = harness({ fetchImpl })
    h.logins.cookieHeader.mockResolvedValue('fixture_session=private-ticket')
    const result = await h.acquisition.resolve('123456', platform, 'official', platform === 'bilibili' ? '150' : undefined)
    expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error', reason: 'credentials-cross-origin' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.buffer.start).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/private-ticket|media-cdn\.fixture/)
    h.acquisition.dispose()
  })

  it('retains sensitive headers on same-origin redirects while keeping them out of media inputs', async () => {
    const calls: Array<{ url: string; cookie: string | null }> = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, cookie: new Headers(init?.headers).get('Cookie') })
      return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: '/same-origin-metadata' } }) : Response.json(biliPayload)
    })
    const h = harness({ fetchImpl })
    h.logins.cookieHeader.mockResolvedValue('fixture_session=same-origin-ticket')
    expect((await h.acquisition.resolve('123456', 'bilibili', 'official', '150')).ok).toBe(true)
    expect(calls).toEqual([
      { url: entryUrl('bilibili'), cookie: 'fixture_session=same-origin-ticket' },
      { url: 'https://api.live.bilibili.com/same-origin-metadata', cookie: 'fixture_session=same-origin-ticket' },
    ])
    expect(JSON.stringify(h.inputs)).not.toMatch(/Cookie|fixture_session|same-origin-ticket/)
    h.acquisition.dispose()
  })

  it('preserves explicit Bilibili login-required failures and removes upstream details at the API boundary', async () => {
    const h = harness({ fetchImpl: async () => Response.json({ code: -101, message: 'SESSDATA=PRIVATE' }) })
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition: h.acquisition })
    const result = await service.invoke('resolve', { input: '123456', platform: 'bilibili', role: 'official' })
    expect(result).toMatchObject({ ok: true, value: { ok: false, failure: { code: 'login-required', hint: expect.stringContaining('登录') } } })
    expect(JSON.stringify(result)).not.toMatch(/SESSDATA|PRIVATE/)
    expect(h.buffer.start).not.toHaveBeenCalled()
    service.dispose()
  })

  it('binds the cookie capability to the selected platform instead of exposing other platform accounts', async () => {
    const h = harness()
    const resolver = vi.spyOn(platformResolvers, 'resolveStream').mockImplementation(async (_input, deps) => {
      expect(await deps.cookieHeader!('huya', 'https://www.huya.com/123456')).toBe('')
      expect(h.logins.cookieHeader).not.toHaveBeenCalled()
      return { ok: false, failure: { code: 'unsupported-url', message: 'fixture' } }
    })
    try { await h.acquisition.resolve('123456', 'bilibili', 'official') }
    finally { resolver.mockRestore(); h.acquisition.dispose() }
  })

  it.each(['youtube', 'twitch', 'direct'] as const)('does not expose domestic cookie capability to %s resolvers', async platform => {
    const h = harness()
    const resolver = vi.spyOn(platformResolvers, 'resolveStream').mockImplementation(async (_input, deps) => {
      expect(deps.cookieHeader).toBeUndefined()
      return { ok: false, failure: { code: 'unsupported-url', message: 'fixture' } }
    })
    try {
      await h.acquisition.resolve('fixture', platform, 'official')
      expect(h.logins.cookieHeader).not.toHaveBeenCalled()
    } finally { resolver.mockRestore(); h.acquisition.dispose() }
  })
})

describe('confirmed Douyu selection pin', () => {
  it('keeps watch room, CDN and actual received bytes in main and replaces the metric generation on reconnect', async () => {
    let bytes = 0
    const h = harness({ resolveDouyuRoom: async () => ({ ok: true, identity: { room: '6979222', inputRoom: '6657' } }),
      mediaInput: async () => ({ url: 'http://127.0.0.1:12345/media/fixture', proxyUrl: '', readBytes: () => bytes }),
      fetchImpl: async input => Response.json(String(input).includes('getEncryption')
        ? { error: 0, data: { rand_str: 'seed', key: 'key', enc_time: 1, is_special: 0, enc_data: 'enc' } }
        : { error: 0, data: { rtmp_url: 'https://media.edgesrv.com/live', rtmp_live: 'stream.flv?signature=PRIVATE', rtmp_cdn: 'tct-h5', rate: 0 } }) })
    expect(await h.acquisition.resolve('6657', 'douyu', 'commentary')).toMatchObject({ ok: true })
    bytes = 1234
    const source = h.acquisition.watchSource('commentary')!
    expect(source).toMatchObject({ room: '6979222', cdn: 'tct-h5', bytes: 1234 })
    expect(h.acquisition.describe('commentary')).not.toHaveProperty('douyuWatchCdn')
    expect(JSON.stringify(source)).not.toContain('PRIVATE')
    await h.reconnect()
    expect(h.acquisition.watchSource('commentary')!.generation).not.toBe(source.generation)
    await h.acquisition.stop('commentary')
    expect(h.acquisition.watchSource('commentary')).toBeNull()
    h.acquisition.dispose()
  })

  it('retains the original input but pins reconnect and quality changes to the confirmed room', async () => {
    const room = vi.fn(async () => ({ ok: true as const, identity: { room: '6979222', inputRoom: '6657' } }))
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const seed = { rand_str: 'seed', key: 'key', enc_time: 1, is_special: 0, enc_data: 'enc' }
    const h = harness({ resolveDouyuRoom: room, fetchImpl: async (input, init) => {
      const url = String(input); requests.push({ url, init })
      return new Response(JSON.stringify(url.includes('getEncryption') ? { error: 0, data: seed } : { error: 0, data: {
        rtmp_url: 'https://media.edgesrv.com/live', rtmp_live: 'stream.flv', rate: 0, multirates: [{ rate: 0, name: '原画' }, { rate: 4, name: '高清' }],
      } }))
    } })
    const initial = await h.acquisition.resolve('6657', 'douyu', 'commentary')
    expect(initial).toMatchObject({ ok: true, stream: { channel: '6979222', danmakuRoom: '6979222', sourceRoom: '6979222' } })
    room.mockResolvedValue({ ok: true, identity: { room: '9999', inputRoom: '6657' } })
    await h.reconnect()
    expect(await h.acquisition.switchQuality('commentary', '4')).toMatchObject({ ok: true, stream: { channel: '6979222', sourceRoom: '6979222' } })
    expect(room).toHaveBeenCalledTimes(1)
    const play = requests.filter(request => request.url.includes('getH5PlayV1'))
    expect(play).toHaveLength(3)
    expect(play.every(request => request.url.endsWith('/6979222'))).toBe(true)
    const { buildDouyuAuth } = await import('../server/platforms/douyu')
    for (const request of play) {
      const body = new URLSearchParams(String(request.init?.body))
      expect(body.get('auth')).toBe(buildDouyuAuth('6979222', Number(body.get('tt')), seed))
    }
    expect(await h.acquisition.resolve('6657', 'douyu', 'commentary')).toMatchObject({ ok: true, stream: { channel: '9999' } })
    expect(room).toHaveBeenCalledTimes(2)
    h.acquisition.dispose()
  })
})
