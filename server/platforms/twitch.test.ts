import { describe, expect, it, vi } from 'vitest'
import { resolveTwitch } from './twitch'
import { hlsVariants } from './hlsVariant'
import type { ResolverDeps } from './types'
import { StreamFailureError } from '../networkFailure'

const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=99999999,CODECS="mp4a.40.2",VIDEO="audio_only"', 'audio.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,FRAME-RATE=30,VIDEO="720p30"', 'low.m3u8?sig=fixture',
  '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,VIDEO="chunked"', 'source.m3u8?sig=fixture',
].join('\n')

function dependencies(quality?: string): ResolverDeps {
  return {
    quality, proxify: url => url,
    fetchJson: vi.fn(async () => ({ data: { streamPlaybackAccessToken: { signature: 'fixture', value: 'token' } } })),
    fetchText: vi.fn(async () => master),
  }
}

describe('Twitch upstream quality selection', () => {
  it('parses video variants, excludes audio-only and defaults to the highest', async () => {
    const result = await resolveTwitch('fixture_channel', dependencies())
    expect(result).toMatchObject({ ok: true, stream: {
      quality: 'chunked', qualities: [
        { id: 'chunked', label: '1080p60 (原画)', height: 1080, fps: 60 },
        { id: '720p30', label: '720p30', height: 720, fps: 30 },
      ],
    } })
    expect(result.ok && result.stream.url).toContain('/source.m3u8?sig=fixture')
  })

  it('renews the token and selects the same rendition ID after signature renewal', async () => {
    let signature = 0
    const deps = dependencies('720p30')
    deps.fetchJson = vi.fn(async () => ({ data: { streamPlaybackAccessToken: { signature: String(++signature), value: 'token' } } }))
    deps.fetchText = vi.fn(async url => {
      const sig = new URL(url).searchParams.get('sig')
      return master.replaceAll('sig=fixture', `sig=${sig}`)
    })
    const first = await resolveTwitch('fixture_channel', deps)
    const second = await resolveTwitch('fixture_channel', deps)
    expect(deps.fetchJson).toHaveBeenCalledTimes(2)
    expect(first).toMatchObject({ ok: true, stream: { quality: '720p30' } })
    expect(second).toMatchObject({ ok: true, stream: { quality: '720p30' } })
    expect(first.ok && first.stream.url).toContain('/low.m3u8?sig=1')
    expect(second.ok && second.stream.url).toContain('/low.m3u8?sig=2')
  })

  it('falls back to the highest available rendition and explains a missing selection', async () => {
    const result = await resolveTwitch('fixture_channel', dependencies('removed'))
    expect(result).toMatchObject({ ok: true, stream: { quality: 'chunked' } })
    expect(result.ok && result.stream.notes?.join(' ')).toContain('请求的 Twitch 画质当前不可用')
  })

  it('uses stable resolution IDs when a master omits VIDEO groups', () => {
    const variants = hlsVariants(master.replace(/,VIDEO="[^"]+"/g, ''), 'https://video.ttvnw.net/live/master.m3u8')
    expect(variants?.map(variant => variant.id)).toEqual(['video-1080p60', 'video-720p30'])
  })

  it('resolves relative variants against the final URL after master redirection', async () => {
    const deps = dependencies('720p30')
    deps.fetchPlaylist = vi.fn(async () => ({ text: master, finalUrl: 'https://redirect.ttvnw.net/live/final/master.m3u8' }))
    const result = await resolveTwitch('fixture_channel', deps)
    expect(result.ok && result.stream.url).toBe('https://redirect.ttvnw.net/live/final/low.m3u8?sig=fixture')
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it.each(['token', 'playlist'])('retains structured network errors from the %s request', async phase => {
    const deps = dependencies()
    const error = new StreamFailureError({ stage: 'proxy', code: 'proxy-rejected', message: '代理拒绝连接.' })
    if (phase === 'token') deps.fetchJson = async () => { throw error }
    else deps.fetchText = async () => { throw error }
    await expect(resolveTwitch('fixture_channel', deps)).rejects.toBe(error)
  })

  it('rejects malformed playlists without echoing signed upstream errors', async () => {
    const deps = dependencies()
    deps.fetchText = async () => { throw new Error('https://fixture.invalid/?Cookie=PRIVATE') }
    const result = await resolveTwitch('fixture_channel', deps)
    expect(result).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Cookie|fixture\.invalid/)
  })
})
