import { describe, expect, it, vi } from 'vitest'
import { Acquisition } from '../../electron/acquisition'
import { buildFfmpegArgs, type BufferInput, type BufferState } from '../../electron/bufferManager'
import { readOpenStream, StreamSessions } from '../../electron/streamSessions'
import { createDesktopService } from '../api'
import { resolveConfig } from '../config'
import { DEFAULT_MEDIA_NETWORK } from '../mediaNetworkOptions'
import { MediaRegistry } from '../mediaProxy'
import { detectPlatform } from './index'
import { inspectDirectHlsStream, parseDirectHlsMaster } from './directHls'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))

describe('parseDirectHlsMaster', () => {
  it('returns null for media playlists and external-audio master playlists', () => {
    expect(parseDirectHlsMaster('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg0.ts\n', 'https://cdn.example/live.m3u8')).toBeNull()
    expect(parseDirectHlsMaster([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'video.m3u8',
    ].join('\n'), 'https://cdn.example/master.m3u8')).toBeNull()
  })

  it('sorts renditions highest-first, skips audio-only variants, and disambiguates equal resolutions by bitrate', () => {
    const variants = parseDirectHlsMaster([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
      'audio-only.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=30',
      '720p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,FRAME-RATE=60',
      '1080p-low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60',
      '1080p-high/index.m3u8',
    ].join('\n'), 'https://cdn.example/live/master.m3u8')

    expect(variants).toEqual([
      {
        id: '1080p60-8000000',
        label: '1080p60 (8 Mbps)',
        url: 'https://cdn.example/live/1080p-high/index.m3u8',
        width: 1920,
        height: 1080,
        fps: 60,
        bandwidth: 8_000_000,
      },
      {
        id: '1080p60-4000000',
        label: '1080p60 (4 Mbps)',
        url: 'https://cdn.example/live/1080p-low/index.m3u8',
        width: 1920,
        height: 1080,
        fps: 60,
        bandwidth: 4_000_000,
      },
      {
        id: '720p30-2500000',
        label: '720p',
        url: 'https://cdn.example/live/720p/index.m3u8',
        width: 1280,
        height: 720,
        fps: 30,
        bandwidth: 2_500_000,
      },
    ])

    const bandwidthOnly = parseDirectHlsMaster([
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000',
      'sd.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4500000',
      'hd.m3u8',
    ].join('\n'), 'https://cdn.example/master.m3u8')
    expect(bandwidthOnly?.map(item => item.label)).toEqual(['4.5 Mbps', '1.5 Mbps'])
  })

  it('falls back to progressive when a .m3u8 URL serves binary FLV bytes', async () => {
    const cancel = vi.fn()
    const flvBytes = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09])
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(flvBytes) },
      cancel,
    }))
    const stream = await inspectDirectHlsStream(
      { platform: 'direct', url: 'https://cdn.example/mislabelled.m3u8', kind: 'hls', label: 'cdn.example', channel: 'cdn.example', requiresProxy: false },
      undefined,
      resolveConfig({}).proxy,
      { route: async () => ({ kind: 'direct' }), media: DEFAULT_MEDIA_NETWORK },
      fetchImpl,
    )
    expect(stream.kind).toBe('progressive')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('direct live stream acquisition, headers, fMP4 muxing, and boundaries', () => {
  it('classifies Huya CDN subdomains as direct while keeping Huya room hosts on huya', () => {
    expect(detectPlatform('https://al.flv.huya.com/src/stream-id?wsSecret=1')).toBe('direct')
    expect(detectPlatform('https://tx.hls.huya.com/src/stream.m3u8')).toBe('direct')
    expect(detectPlatform('https://www.huya.com/660000')).toBe('huya')
  })

  it('resolves direct master m3u8 variants, switches quality, preserves custom headers/label, and enables fMP4 for HEVC', async () => {
    const observedHeaders: Headers[] = []
    const inputs: BufferInput[] = []
    const listeners = new Set<(state: BufferState) => void>()
    const mediaInput = vi.fn(async (url: string, headers: Record<string, string> | undefined) => ({
      url: 'http://127.0.0.1:19000/media/00000000-0000-4000-8000-000000000001',
      proxyUrl: '',
      headers,
      targetUrl: url,
    }))
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      observedHeaders.push(new Headers(init?.headers))
      return new Response([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=30',
        'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60',
        'high.m3u8',
      ].join('\n'))
    })
    const acquisition = new Acquisition({
      buffer: {
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        start: async (role, prepare) => {
          inputs.push(await prepare())
          for (const listener of listeners) listener({ role, state: 'ready', seconds: 4, hasVideo: true, completeSegments: 1 })
          return { url: `app://app/buffer/session/${role}/gen/index.m3u8` }
        },
        stop: async () => {},
      },
      logins: { cookieHeader: async () => '', login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn() },
      runYtDlp: vi.fn(),
      mediaInput: mediaInput as never,
      network: () => ({ route: async () => ({ kind: 'direct' }), media: DEFAULT_MEDIA_NETWORK }),
      proxy: { ...resolveConfig({}).proxy, hosts: ['*'] },
      fetchImpl,
      dns: async () => ['8.8.8.8'],
    })

    try {
      const resolved = await acquisition.resolve(
        'https://cdn.example/live/master.m3u8',
        'direct',
        'official',
        undefined,
        false,
        { label: '官方纯净流', headers: { Referer: 'https://live.example/', 'User-Agent': 'CustomUA/2.0' } },
      )
      expect(resolved).toMatchObject({
        ok: true,
        stream: {
          platform: 'direct',
          label: '官方纯净流',
          quality: '1080p60-6000000',
          qualities: [
            { id: '1080p60-6000000', label: '1080p60', height: 1080, fps: 60 },
            { id: '720p30-2000000', label: '720p', height: 720, fps: 30 },
          ],
        },
      })
      // Never leak headers across IPC
      expect(JSON.stringify(resolved)).not.toMatch(/CustomUA|live\.example/)
      expect(observedHeaders[0]!.get('Referer')).toBe('https://live.example/')
      expect(observedHeaders[0]!.get('User-Agent')).toBe('CustomUA/2.0')
      expect(mediaInput).toHaveBeenCalledWith(
        'https://cdn.example/live/high.m3u8',
        { Referer: 'https://live.example/', 'User-Agent': 'CustomUA/2.0' },
        expect.any(Object),
        expect.any(Object),
      )
      expect(inputs[0]).toMatchObject({ fmp4: true, gatewayHls: true })

      const ffmpegArgs = buildFfmpegArgs(inputs[0]!, '/tmp/buf', 0, 'pipe:3', Boolean(inputs[0]!.fmp4))
      expect(ffmpegArgs).toContain('fmp4')
      expect(ffmpegArgs).toContain('aac_adtstoasc')

      const switched = await acquisition.switchQuality('official', '720p30-2000000')
      expect(switched).toMatchObject({
        ok: true,
        stream: { label: '官方纯净流', quality: '720p30-2000000' },
      })
      expect(mediaInput).toHaveBeenLastCalledWith(
        'https://cdn.example/live/low.m3u8',
        { Referer: 'https://live.example/', 'User-Agent': 'CustomUA/2.0' },
        expect.any(Object),
        expect.any(Object),
      )
    } finally {
      acquisition.dispose()
    }
  })

  it('replaces default User-Agent and Referer case-insensitively in MediaRegistry without header concatenation', async () => {
    const sent: Headers[] = []
    const registry = new MediaRegistry({
      config: resolveConfig({}).proxy,
      resolve: async () => ['8.8.8.8'],
      fetchImpl: async (_input, init) => {
        sent.push(new Headers(init?.headers))
        return new Response('flv-bytes')
      },
    })
    try {
      const cap1 = registry.register('https://al.flv.huya.com/src/live.flv', undefined, { route: async () => ({ kind: 'direct' }), media: DEFAULT_MEDIA_NETWORK })
      await (await registry.handle(new Request(cap1))).text()
      expect(sent[0]!.get('referer')).toBe('https://www.huya.com/')

      const cap2 = registry.register(
        'https://al.flv.huya.com/src/live2.flv',
        { Referer: 'https://custom.example/', 'User-Agent': 'PurePlayer/1.0' },
        { route: async () => ({ kind: 'direct' }), media: DEFAULT_MEDIA_NETWORK },
      )
      await (await registry.handle(new Request(cap2))).text()
      expect(sent[1]!.get('referer')).toBe('https://custom.example/')
      expect(sent[1]!.get('user-agent')).toBe('PurePlayer/1.0')
    } finally {
      await registry.dispose()
    }
  })

  it('rejects custom direct options when paired with a non-direct platform in DesktopService and StreamSessions', async () => {
    const proxy = { ...resolveConfig({}).proxy, hosts: ['*'] }
    const service = createDesktopService({ dataDir: '.', proxy, registerMedia: url => `app://app/media/${encodeURIComponent(url)}` })
    try {
      expect(await service.invoke('resolve', {
        input: '6657',
        platform: 'douyu',
        direct: { headers: { Referer: 'https://evil.example/' } },
      })).toMatchObject({ ok: false, code: 'invalid-arguments' })

      expect(await service.invoke('resolve', {
        input: 'https://8.8.8.8/live.flv',
        platform: 'direct',
        direct: { label: '测试FLV', headers: { Referer: 'https://ok.example/' } },
      })).toMatchObject({
        ok: true,
        value: { ok: true, stream: { platform: 'direct', label: '测试FLV' } },
      })
    } finally {
      service.dispose()
    }

    expect(() => readOpenStream({
      input: '6657',
      platform: 'douyu',
      direct: { label: '不允许' },
    })).toThrow()

    const openDirect = readOpenStream({
      input: 'https://8.8.8.8/live.flv',
      platform: 'direct',
      direct: { label: '同屏纯流', headers: { Referer: 'https://ok.example/' } },
    })
    expect(openDirect).toEqual({
      input: 'https://8.8.8.8/live.flv',
      platform: 'direct',
      direct: { label: '同屏纯流', headers: { Referer: 'https://ok.example/' } },
    })

    const resolveSpy = vi.fn(async () => ({
      ok: true as const,
      stream: { platform: 'direct' as const, url: 'app://app/buffer/s/r/g/index.m3u8', kind: 'hls' as const, label: '同屏纯流', channel: '8.8.8.8', requiresProxy: false },
    }))
    const sessions = new StreamSessions({
      resolve: resolveSpy,
      switchQuality: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(async () => {}),
      subscribe: () => () => {},
      describe: () => null,
    })
    await sessions.open(openDirect)
    expect(resolveSpy).toHaveBeenCalledWith(
      'https://8.8.8.8/live.flv',
      'direct',
      expect.stringMatching(/^stream-/),
      undefined,
      undefined,
      { label: '同屏纯流', headers: { Referer: 'https://ok.example/' } },
    )
    await sessions.dispose()
  })
})
