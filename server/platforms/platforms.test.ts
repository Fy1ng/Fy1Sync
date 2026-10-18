import { describe, expect, it } from 'vitest'
import { parseBilibiliRoom } from './bilibili'
import { douyuRoomFor, parseDouyuRoom, resolveDouyu } from './douyu'
import { detectPlatform, looksLikeDirectMedia, resolveStream } from './index'
import { parseTwitchChannel, resolveTwitch } from './twitch'
import { resolveBilibili } from './bilibili'
import type { ResolverDeps } from './types'

/** Deps that fail loudly: each test overrides only the call it expects. */
function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return {
    fetchJson: async () => {
      throw new Error('unexpected fetchJson')
    },
    fetchText: async () => {
      throw new Error('unexpected fetchText')
    },
    proxify: (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
    ...overrides,
  }
}

describe('parseTwitchChannel', () => {
  it('accepts a bare channel name', () => {
    expect(parseTwitchChannel('esl_csgo')).toBe('esl_csgo')
    expect(parseTwitchChannel('  ESL_CSGO  ')).toBe('esl_csgo')
  })

  it('accepts channel URLs in several forms', () => {
    expect(parseTwitchChannel('https://www.twitch.tv/esl_csgo')).toBe('esl_csgo')
    expect(parseTwitchChannel('twitch.tv/esl_csgo')).toBe('esl_csgo')
    expect(parseTwitchChannel('https://m.twitch.tv/esl_csgo?tt_medium=x')).toBe('esl_csgo')
    expect(parseTwitchChannel('https://www.twitch.tv/esl_csgo/')).toBe('esl_csgo')
  })

  it('rejects VOD and clip URLs', () => {
    expect(parseTwitchChannel('https://www.twitch.tv/videos/123456789')).toBeNull()
    expect(parseTwitchChannel('https://www.twitch.tv/esl_csgo/clip/AbcDef')).toBeNull()
  })

  it('rejects reserved paths', () => {
    for (const path of ['directory', 'settings', 'downloads', 'p/some-page']) {
      expect(parseTwitchChannel(`https://www.twitch.tv/${path}`)).toBeNull()
    }
  })

  it('rejects an empty or invalid name', () => {
    expect(parseTwitchChannel('')).toBeNull()
    expect(parseTwitchChannel('https://www.twitch.tv/')).toBeNull()
    expect(parseTwitchChannel('has spaces')).toBeNull()
  })
})

describe('resolveTwitch', () => {
  const tokenResponse = {
    data: {
      streamPlaybackAccessToken: {
        value: '{"channel":"esl_csgo"}',
        signature: 'deadbeef',
      },
    },
  }

  it('builds a signed usher URL from the playback access token', async () => {
    let requested = ''
    let payload = ''
    const result = await resolveTwitch(
      'https://www.twitch.tv/esl_csgo',
      deps({
        fetchJson: async (url, init) => {
          requested = url
          payload = String(init?.body ?? '')
          return tokenResponse
        },
      }),
    )

    expect(requested).toBe('https://gql.twitch.tv/gql')
    expect(payload).toContain('PlaybackAccessToken')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const proxied = new URL(result.stream.url, 'http://127.0.0.1')
    const usher = new URL(decodeURIComponent(proxied.searchParams.get('url')!))
    expect(usher.origin + usher.pathname).toBe('https://usher.ttvnw.net/api/channel/hls/esl_csgo.m3u8')
    expect(usher.searchParams.get('sig')).toBe('deadbeef')
    expect(usher.searchParams.get('token')).toBe('{"channel":"esl_csgo"}')
    expect(usher.searchParams.get('allow_source')).toBe('true')
    expect(result.stream.kind).toBe('hls')
    expect(result.stream.requiresProxy).toBe(true)
    expect(result.stream.channel).toBe('esl_csgo')
  })

  it('reports not-live with a manual-URL hint when no token comes back', async () => {
    const result = await resolveTwitch(
      'esl_csgo',
      deps({ fetchJson: async () => ({ data: { streamPlaybackAccessToken: null } }) }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('not-live')
    expect(result.failure.hint).toContain('m3u8')
  })

  it('reports upstream-error when the GQL call throws', async () => {
    const result = await resolveTwitch(
      'esl_csgo',
      deps({
        fetchJson: async () => {
          throw new Error('HTTP 503')
        },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('upstream-error')
  })

  it('rejects an unparseable channel before making any request', async () => {
    const result = await resolveTwitch('https://www.twitch.tv/videos/1', deps())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('unsupported-url')
  })
})

describe('parseDouyuRoom', () => {
  it('accepts a numeric id and URL forms', () => {
    expect(parseDouyuRoom('288016')).toBe('288016')
    expect(parseDouyuRoom('https://www.douyu.com/288016')).toBe('288016')
    expect(parseDouyuRoom('douyu.com/288016?x=1')).toBe('288016')
    expect(parseDouyuRoom('https://www.douyu.com/topic/x?rid=288016')).toBe('288016')
  })

  it('rejects vanity paths and non-numeric ids', () => {
    expect(parseDouyuRoom('https://www.douyu.com/myroom')).toBeNull()
    expect(parseDouyuRoom('abc')).toBeNull()
    expect(parseDouyuRoom('')).toBeNull()
  })

  it('exposes the room id alone for the danmaku relay', () => {
    expect(douyuRoomFor('https://www.douyu.com/288016')).toBe('288016')
    expect(douyuRoomFor('nope')).toBeNull()
  })
})

describe('resolveDouyu', () => {
  it('uses hls_url when the room API returns one', async () => {
    const result = await resolveDouyu(
      '288016',
      deps({
        fetchJson: async (url) => {
          expect(url).toContain('/api/RoomApi/room/288016')
          return {
            error: 0,
            data: {
              room_id: '288016',
              room_name: '解说间',
              online: 12345,
              room_status: '1',
              hls_url: 'https://hlsa.douyucdn.cn/live/288016.m3u8',
            },
          }
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stream.kind).toBe('hls')
    expect(result.stream.danmakuRoom).toBe('288016')
    expect(result.stream.requiresProxy).toBe(true)
    expect(decodeURIComponent(result.stream.url)).toContain('https://hlsa.douyucdn.cn/live/288016.m3u8')
  })

  it('falls back to an http rtmp_url that is really an m3u8', async () => {
    const result = await resolveDouyu(
      '288016',
      deps({
        fetchJson: async () => ({
          error: 0,
          data: {
            room_id: '288016',
            room_name: 'x',
            room_status: '1',
            hls_url: '',
            rtmp_url: 'https://hlsa.douyucdn.cn/live',
            rtmp_live: '288016rkKb.m3u8?wsSecret=abc',
          },
        }),
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(decodeURIComponent(result.stream.url)).toContain('288016rkKb.m3u8')
  })

  it('needs a manual URL but still surfaces the room id for danmaku', async () => {
    const result = await resolveDouyu(
      '288016',
      deps({
        fetchJson: async () => ({
          error: 0,
          data: { room_id: '288016', room_name: 'x', room_status: '1', hls_url: '' },
        }),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('needs-manual-url')
    // Danmaku does not need the video URL, so the hint must not lose the room number.
    expect(result.failure.hint).toContain('288016')
  })

  it('reports a closed room as not-live', async () => {
    const result = await resolveDouyu(
      '288016',
      deps({
        fetchJson: async () => ({
          error: 0,
          data: {
            room_id: '288016',
            room_name: 'x',
            room_status: '2',
            hls_url: 'https://hlsa.douyucdn.cn/live/x.m3u8',
          },
        }),
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('not-live')
  })

  it('reports room-not-found when the API returns an error code', async () => {
    const result = await resolveDouyu(
      '999999999',
      deps({ fetchJson: async () => ({ error: 101, data: null }) }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('room-not-found')
  })
})

describe('parseBilibiliRoom', () => {
  it('accepts live-host room URLs and bare ids', () => {
    expect(parseBilibiliRoom('https://live.bilibili.com/21470454')).toBe('21470454')
    expect(parseBilibiliRoom('live.bilibili.com/21470454?spm=x')).toBe('21470454')
    expect(parseBilibiliRoom('21470454')).toBe('21470454')
  })

  it('rejects non-live bilibili URLs', () => {
    expect(parseBilibiliRoom('https://www.bilibili.com/video/BV1xx')).toBeNull()
    expect(parseBilibiliRoom('https://space.bilibili.com/123')).toBeNull()
  })
})

describe('resolveBilibili', () => {
  const playInfo = (streams: unknown) => ({
    code: 0,
    data: {
      live_status: 1,
      room_id: 21470454,
      playurl_info: { playurl: { stream: streams } },
    },
  })

  const hlsStream = [
    {
      protocol_name: 'http_hls',
      format: [
        {
          format_name: 'fmp4',
          codec: [
            {
              codec_name: 'avc',
              base_url: '/live-bvc/123/live_1_2.m3u8',
              url_info: [{ host: 'https://cn-hls.bilivideo.com', extra: '?expires=1&sign=a' }],
            },
          ],
        },
      ],
    },
  ]

  it('prefers an fmp4 HLS rendition and assembles host + base + extra', async () => {
    const result = await resolveBilibili(
      'https://live.bilibili.com/21470454',
      deps({ fetchJson: async () => playInfo(hlsStream) }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(decodeURIComponent(result.stream.url)).toContain(
      'https://cn-hls.bilivideo.com/live-bvc/123/live_1_2.m3u8?expires=1&sign=a',
    )
    expect(result.stream.kind).toBe('hls')
  })

  it('reports not-live when the room is offline', async () => {
    const result = await resolveBilibili(
      '21470454',
      deps({ fetchJson: async () => ({ code: 0, data: { live_status: 0 } }) }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('not-live')
  })

  it('reports upstream-error on a non-zero API code', async () => {
    const result = await resolveBilibili(
      '21470454',
      deps({ fetchJson: async () => ({ code: -400, message: 'bad request' }) }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('upstream-error')
  })

  it('needs a manual URL when no playable rendition is present', async () => {
    const result = await resolveBilibili('21470454', deps({ fetchJson: async () => playInfo([]) }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('needs-manual-url')
  })
})

describe('detectPlatform', () => {
  it('routes by hostname', () => {
    expect(detectPlatform('https://www.twitch.tv/esl_csgo')).toBe('twitch')
    expect(detectPlatform('https://www.douyu.com/288016')).toBe('douyu')
    expect(detectPlatform('https://live.bilibili.com/21470454')).toBe('bilibili')
  })

  it('recognises direct media URLs', () => {
    expect(detectPlatform('https://cdn.example.com/live/index.m3u8')).toBe('direct')
    expect(detectPlatform('http://127.0.0.1:5173/test-sources/clock.mp4')).toBe('direct')
  })

  it('honours an explicit override', () => {
    expect(detectPlatform('esl_csgo', 'twitch')).toBe('twitch')
    expect(detectPlatform('288016', 'douyu')).toBe('douyu')
  })

  it('returns null for input it cannot place', () => {
    expect(detectPlatform('')).toBeNull()
    expect(detectPlatform('some random words')).toBeNull()
    expect(detectPlatform('https://example.com/watch')).toBeNull()
  })
})

describe('looksLikeDirectMedia', () => {
  it('requires an http(s) scheme and a media extension', () => {
    expect(looksLikeDirectMedia('https://a.example/x.m3u8')).toBe(true)
    expect(looksLikeDirectMedia('https://a.example/x.mp4?token=1')).toBe(true)
    expect(looksLikeDirectMedia('a.example/x.mp4')).toBe(false)
    expect(looksLikeDirectMedia('https://a.example/x')).toBe(false)
    expect(looksLikeDirectMedia('file:///c:/x.mp4')).toBe(false)
  })
})

describe('resolveStream', () => {
  it('returns a direct progressive source unproxied', async () => {
    const result = await resolveStream('https://cdn.example.com/clip.mp4', deps())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stream.platform).toBe('direct')
    expect(result.stream.kind).toBe('progressive')
    expect(result.stream.requiresProxy).toBe(false)
    expect(result.stream.url).toBe('https://cdn.example.com/clip.mp4')
  })

  it('marks a direct m3u8 as hls', async () => {
    const result = await resolveStream('https://cdn.example.com/live/index.m3u8', deps())
    expect(result.ok && result.stream.kind).toBe('hls')
  })

  it('rejects a non-http direct URL', async () => {
    const result = await resolveStream('https://a.example/x.mp4', deps())
    expect(result.ok).toBe(true)
    const bad = await resolveStream('ftp://a.example/x.mp4', deps(), 'direct')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.failure.code).toBe('unsupported-url')
  })

  it('explains itself when the platform cannot be determined', async () => {
    const result = await resolveStream('what is this', deps())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe('unsupported-url')
      expect(result.failure.hint).toContain('m3u8')
    }
  })
})
