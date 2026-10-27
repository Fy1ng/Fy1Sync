import { describe, expect, it, vi } from 'vitest'
import type { BufferInput, BufferState } from './bufferManager'
import { Acquisition } from './acquisition'
import { resolveConfig } from '../server/config'
import { createDesktopService } from '../server/api'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))

function harness(overrides: Partial<ConstructorParameters<typeof Acquisition>[0]> = {}) {
  const listeners = new Set<(state: BufferState) => void>()
  const inputs: BufferInput[] = []
  let resolver: ((hlsOnly?: boolean) => Promise<BufferInput>) | undefined
  const emit = (state: BufferState) => { for (const listener of listeners) listener(state) }
  const buffer = {
    subscribe: (listener: (state: BufferState) => void) => {
      listeners.add(listener)
      listener({ role: 'official', state: 'ready', seconds: 99 })
      return () => { listeners.delete(listener) }
    },
    start: vi.fn(async (role, prepare) => {
      resolver = prepare
      emit({ role, state: 'starting', seconds: 0 })
      inputs.push(await prepare())
      emit({ role, state: 'ready', seconds: 6 })
      return { url: `app://app/buffer/session/${role}/generation/index.m3u8` }
    }),
    stop: vi.fn(async () => {}),
  }
  const logins = {
    cookieHeader: vi.fn(async () => ''), login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(),
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

  it.each(['https://127.0.0.1/private.m3u8', 'https://169.254.169.254/private.m3u8'])('rejects an unsafe highest Twitch rendition before buffering: %s', async uri => {
    const h = harness({ fetchImpl: async input => String(input).includes('gql.twitch.tv')
      ? Response.json({ data: { streamPlaybackAccessToken: { value: 'PRIVATE', signature: 'PRIVATE' } } })
      : new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60\n' + uri),
    })
    await expect(h.acquisition.resolve('twitch.tv/pgl', 'twitch', 'official', undefined, true)).rejects.toHaveProperty('reason', 'private-address')
    expect(h.buffer.start).not.toHaveBeenCalled()
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
    expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false)
    service.dispose()
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
      h.emit({ role, state: 'ready', seconds: 6 })
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
    expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false)
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

  it.each(['http://127.0.0.1/x.mp4', 'http://169.254.169.254/x.m3u8', 'https://user:password@8.8.8.8/x.flv'])('rejects untrusted direct input %s before spawning', async (input) => {
    const h = harness()
    await expect(h.acquisition.resolve(input, 'direct', 'official')).rejects.toHaveProperty('reason')
    expect(h.buffer.start).not.toHaveBeenCalled()
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
    h.emit({ role: 'official', state: 'ready', seconds: 6 })
    expect((await operation).ok).toBe(true)
  })

  it('does not publish a source on a premature ready event with less than four seconds', async () => {
    const h = harness()
    let started = false
    h.buffer.start.mockImplementationOnce(async (_role, prepare) => {
      await prepare(); started = true
      h.emit({ role: 'official', state: 'ready', seconds: 0.033333 })
      return { url: 'app://app/buffer/partial/index.m3u8' }
    })
    let finished = false
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official').then(value => { finished = true; return value })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(finished).toBe(false)
    h.emit({ role: 'official', state: 'ready', seconds: 4 })
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
    if (!recovered) expect(h.runYtDlp).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=abcdefghijk', false)
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
    expect(await service.invoke('resolve', { input: 'http://127.0.0.1:9/secret', platform: 'direct' })).toMatchObject({ ok: false, code: 'bad-port' })
    expect(ensureTools).not.toHaveBeenCalled()
    service.dispose()
  })
})


describe('confirmed Douyu selection pin', () => {
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
