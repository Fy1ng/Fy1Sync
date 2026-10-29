import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../server/config'
import { NetworkPolicy, type DomesticRouting, type NetworkContext } from '../server/networkPolicy'
import * as platforms from '../server/platforms'
import { Acquisition } from './acquisition'
import type { BufferInput, BufferState } from './bufferManager'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))

type Dependencies = ConstructorParameters<typeof Acquisition>[0]
const instances: Acquisition[] = []
afterEach(() => { for (const value of instances.splice(0)) value.dispose(); vi.restoreAllMocks() })
const metadata = () => ({ is_live: true, id: 'abcdefghijk', live_status: 'is_live', formats: [
  { format_id: '301', protocol: 'm3u8_native', height: 1080, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/live.m3u8?signature=PRIVATE' },
] })

function fixture(overrides: Partial<Dependencies> = {}, ready = true) {
  const listeners = new Set<(state: BufferState) => void>()
  const inputs: BufferInput[] = []
  let prepare: ((hlsOnly?: boolean) => Promise<BufferInput>) | undefined
  const emit = (state: BufferState) => { for (const listener of listeners) listener(state) }
  const buffer: Dependencies['buffer'] = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: vi.fn(async (role, resolve) => {
      prepare = resolve
      inputs.push(await resolve())
      if (ready) emit({ role, state: 'ready', seconds: 4, hasVideo: true, completeSegments: 1 })
      return { url: `app://app/buffer/fixture/${role}/generation/index.m3u8` }
    }),
    stop: vi.fn(async () => {}),
  }
  const runYtDlp = vi.fn<Dependencies['runYtDlp']>(async () => metadata())
  const mediaInput = vi.fn<NonNullable<Dependencies['mediaInput']>>(async () => ({ url: 'http://127.0.0.1:19000/media/opaque', proxyUrl: '' }))
  const acquisition = new Acquisition({
    buffer, runYtDlp, mediaInput,
    logins: { cookieHeader: vi.fn(async () => ''), login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn() },
    proxy: { ...resolveConfig({}).proxy, hosts: ['*'] }, dns: async () => ['8.8.8.8'],
    ...overrides,
  })
  instances.push(acquisition)
  return { acquisition, buffer, emit, inputs, runYtDlp, mediaInput, reconnect: (hlsOnly?: boolean) => prepare!(hlsOnly) }
}

describe('acquisition network and readiness integration', () => {
  it('keeps one context through real platform resolution, yt-dlp, media preparation and reconnect', async () => {
    const context: NetworkContext = { route: vi.fn<NetworkContext['route']>(async () => ({ kind: 'direct' })) }
    const factory = vi.fn(() => context)
    const resolver = vi.spyOn(platforms, 'resolveStream')
    const h = fixture({ network: factory })
    const result = await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    expect(result.ok).toBe(true)
    const retried = await h.reconnect()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledWith('youtube')
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(h.runYtDlp).toHaveBeenCalledTimes(2)
    expect(h.runYtDlp.mock.calls.every(call => call[2] === context)).toBe(true)
    expect(h.mediaInput.mock.calls.every(call => call[2] === context)).toBe(true)
    expect(h.inputs[0]?.network).toBe(context)
    expect(retried.network).toBe(context)
    expect(vi.mocked(context.route).mock.calls.every(call => call[0].includes('media.googlevideo.com'))).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|signature|Cookie/)
  })

  it('freezes a domestic session across preference changes and applies the new preference to a new acquisition', async () => {
    let preference: DomesticRouting = 'direct'
    let signature = 0
    const resolveProxy = vi.fn(async () => 'PROXY 127.0.0.1:7890')
    const policy = new NetworkPolicy(resolveProxy, () => preference)
    const factory = vi.fn((platform: Parameters<NonNullable<Dependencies['network']>>[0]) => policy.context(platform))
    vi.spyOn(platforms, 'resolveStream').mockImplementation(async () => ({ ok: true, stream: {
      platform: 'huya', channel: 'fixture', kind: 'progressive', label: '虎牙测试', requiresProxy: true,
      url: `https://cdn.msstatic.com/live.flv?signature=${++signature}`,
    } }))
    const h = fixture({ network: factory })
    expect((await h.acquisition.resolve('huya.com/fixture', 'huya', 'official')).ok).toBe(true)
    const initial = h.inputs[0]!.network!
    preference = 'system'
    const reconnected = await h.reconnect()
    expect(reconnected.network).toBe(initial)
    expect(await initial.route('https://another.msstatic.com/new.flv')).toEqual({ kind: 'direct' })
    expect(resolveProxy).not.toHaveBeenCalled()
    expect((await h.acquisition.resolve('huya.com/fixture', 'huya', 'official')).ok).toBe(true)
    const next = h.inputs[1]!.network!
    expect(next).not.toBe(initial)
    expect(await next.route('https://another.msstatic.com/new.flv')).toMatchObject({ kind: 'http', proxyUrl: 'http://127.0.0.1:7890/' })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(h.mediaInput.mock.calls[0]?.[2]).toBe(initial)
    expect(h.mediaInput.mock.calls[1]?.[2]).toBe(initial)
    expect(h.mediaInput.mock.calls[2]?.[2]).toBe(next)
  })

  it('switches real Twitch variants and refreshes the token before choosing the lower rendition', async () => {
    let signature = 0
    const requests: string[] = []
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://gql.twitch.tv/gql') return Response.json({ data: { streamPlaybackAccessToken: { value: 'PRIVATE_TOKEN', signature: `PRIVATE_${++signature}` } } })
      const renewed = new URL(url).searchParams.get('sig')
      return new Response([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=30,VIDEO="720p30"',
        `https://video.ttvnw.net/low.m3u8?signature=${renewed}`,
        '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,VIDEO="chunked"',
        `https://video.ttvnw.net/high.m3u8?signature=${renewed}`,
      ].join('\n'), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
    }) as typeof fetch
    const h = fixture({ fetchImpl })
    const first = await h.acquisition.resolve('twitch.tv/fixture', 'twitch', 'official')
    expect(first).toMatchObject({ ok: true, stream: { quality: 'chunked', qualities: [
      { id: 'chunked', height: 1080, fps: 60 }, { id: '720p30', height: 720, fps: 30 },
    ] } })
    const low = await h.acquisition.switchQuality('official', '720p30')
    expect(low).toMatchObject({ ok: true, stream: { quality: '720p30' } })
    expect(h.mediaInput.mock.calls[0]?.[0]).toBe('https://video.ttvnw.net/high.m3u8?signature=PRIVATE_1')
    expect(h.mediaInput.mock.calls[1]?.[0]).toBe('https://video.ttvnw.net/low.m3u8?signature=PRIVATE_2')
    expect(requests.filter(url => url === 'https://gql.twitch.tv/gql')).toHaveLength(2)
    expect(JSON.stringify([first, low])).not.toMatch(/PRIVATE|signature|Cookie/)
  })

  it('requires ready phase, reported video and a complete segment before publishing a source', async () => {
    const h = fixture({}, false)
    let settled = false
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official').then(result => { settled = true; return result })
    await vi.waitFor(() => expect(h.inputs).toHaveLength(1))
    const premature: BufferState[] = [
      { role: 'official', state: 'buffering', seconds: 4, hasVideo: true, completeSegments: 1 },
      { role: 'official', state: 'ready', seconds: 4, completeSegments: 1 },
      { role: 'official', state: 'ready', seconds: 4, hasVideo: false, completeSegments: 1 },
      { role: 'official', state: 'ready', seconds: 4, hasVideo: true, completeSegments: 0 },
      { role: 'official', state: 'ready', seconds: 4, hasVideo: true },
      { role: 'official', state: 'ready', seconds: 3.9, hasVideo: true, completeSegments: 1 },
    ]
    for (const state of premature) {
      h.emit(state)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(h.acquisition.describe('official')).toBeNull()
    }
    h.emit({ role: 'official', state: 'ready', seconds: 4, hasVideo: true, completeSegments: 1 })
    expect((await operation).ok).toBe(true)
  })

  it('reports playback-not-ready when complete video evidence never arrives', async () => {
    const h = fixture({ readyTimeoutMs: 20 }, false)
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official')
    expect(await operation).toMatchObject({ ok: false, failure: { stage: 'playback-not-ready', reason: 'first-video-timeout' } })
    expect(h.buffer.stop).toHaveBeenCalledWith('official')
  })

  it.each([
    { stage: 'resolve', reason: 'upstream-error', result: () => new Response('PRIVATE Cookie=https://fixture.invalid/?signature=PRIVATE') },
    { stage: 'proxy', reason: 'proxy-unreachable', result: () => { throw Object.assign(new Error('PRIVATE Cookie=https://fixture.invalid/?signature=PRIVATE'), { code: 'ECONNREFUSED' }) } },
    { stage: 'connect', reason: 'tls-certificate', result: () => { throw Object.assign(new Error('PRIVATE Cookie=https://fixture.invalid/?signature=PRIVATE'), { code: 'CERT_HAS_EXPIRED' }) } },
    { stage: 'http', reason: 'http-403', result: () => new Response('PRIVATE Cookie=https://fixture.invalid/?signature=PRIVATE', { status: 403 }) },
  ])('returns a sanitized structured $stage failure from platform requests', async ({ stage, reason, result }) => {
    const network: NetworkContext = { route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:7890' }) }
    const h = fixture({ network: () => network, fetchImpl: (async () => result()) as typeof fetch })
    const failure = await h.acquisition.resolve('twitch.tv/fixture', 'twitch', 'official')
    expect(failure).toMatchObject({ ok: false, failure: { stage, reason } })
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE|Cookie|signature|https?:\/\//)
    expect(h.buffer.start).not.toHaveBeenCalled()
  })
})
