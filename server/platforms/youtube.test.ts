import { describe, expect, it, vi } from 'vitest'
import fixture from './fixtures/youtube-live.json'
import { detectPlatform, resolveStream } from './index'
import { parseYouTubeUrl, resolveYouTube, selectYouTubeFormat, youtubeFormats } from './youtube'
import type { ResolverDeps } from './types'

function deps(overrides: Partial<ResolverDeps> = {}): ResolverDeps {
  return { fetchJson: vi.fn(), fetchText: vi.fn(), proxify: (url) => url, runYtDlp: async () => fixture, ...overrides }
}

describe('YouTube public page validation', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abcdefghijk&list=private#part', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['youtu.be/abcdefghijk?t=3', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://m.youtube.com/live/abcdefghijk', 'https://www.youtube.com/watch?v=abcdefghijk'],
    ['https://www.youtube.com/@esl', 'https://www.youtube.com/@esl/live'],
    ['youtube.com/channel/UCPublicChannel/live', 'https://www.youtube.com/channel/UCPublicChannel/live'],
    ['https://youtube.com/user/esl', 'https://www.youtube.com/user/esl/live'],
  ])('canonicalizes %s', (input, expected) => {
    expect(parseYouTubeUrl(input)).toBe(expected)
    expect(detectPlatform(input)).toBe('youtube')
  })

  it.each([
    'https://youtube.com.evil.invalid/watch?v=abcdefghijk', 'https://evil.youtube.com/watch?v=abcdefghijk',
    'https://user:secret@youtube.com/watch?v=abcdefghijk', 'https://youtube.com:8080/watch?v=abcdefghijk',
    'file:///youtube.com/watch?v=abcdefghijk', 'https://youtube.com/playlist?list=123',
    'https://youtube.com/redirect?q=http://127.0.0.1', 'https://youtu.be/abc',
    'https://www.youtube.com/watch?v=bad', '',
  ])('rejects %s without starting an extractor', async (input) => {
    const runner = vi.fn()
    expect(parseYouTubeUrl(input)).toBeNull()
    expect((await resolveYouTube(input, deps({ runYtDlp: runner }))).ok).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('YouTube recorded live formats', () => {
  it('exposes recorded dimensions/fps, prefers the best muxed HLS, and dispatches YouTube', async () => {
    const runner = vi.fn(async () => fixture)
    const result = await resolveStream('https://youtube.com/@esl', deps({ runYtDlp: runner }))
    expect(runner).toHaveBeenCalledWith('https://www.youtube.com/@esl/live')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stream).toMatchObject({ platform: 'youtube', kind: 'hls', quality: '301', channel: 'abcdefghijk' })
    expect(result.stream.qualities).toHaveLength(6)
    expect(result.stream.qualities?.[0]).toEqual({ id: '301', label: '1080p60', height: 1080, fps: 60 })
    expect(result.stream.url).toBe('https://media.example.invalid/youtube/301.m3u8')
    expect(result.stream).not.toHaveProperty('headers')
    expect(JSON.stringify(result.stream)).not.toContain('http_headers')
  })

  it.each([['300', '300'], ['720p60', '300'], ['1080p', '301'], ['480p30', '94'], ['auto', '301']])('selects %s', async (quality, id) => {
    const result = await resolveYouTube('youtu.be/abcdefghijk', deps({ quality }))
    expect(result.ok && result.stream.quality).toBe(id)
  })

  it('respects an fps cap and never silently uses a higher height', () => {
    const formats = youtubeFormats(fixture)
    expect(selectYouTubeFormat(formats, '1080p30')?.format_id).toBe('94')
    expect(selectYouTubeFormat(formats, '240p')?.format_id).toBe('92')
    expect(selectYouTubeFormat(formats, '99p')).toBeUndefined()
    expect(selectYouTubeFormat(formats, 'missing')).toBeUndefined()
  })

  it('excludes video-only, audio-only, DASH, unsafe URLs and unsupported copy codecs', () => {
    const format = fixture.formats[5]!
    const formats = [
      { ...format, format_id: 'video', acodec: 'none' }, { ...format, format_id: 'audio', vcodec: 'none' },
      { ...format, format_id: 'dash', protocol: 'http_dash_segments' }, { ...format, format_id: 'file', url: 'file:///secret' },
      { ...format, format_id: 'credentials', url: 'https://user:secret@media.example.invalid/live.m3u8' },
      { ...format, format_id: 'av1', vcodec: 'av01.0.08M.08' }, { ...format, format_id: 'opus', acodec: 'opus' },
      { ...format, format_id: 'bad height', height: NaN }, format, format,
    ]
    expect(youtubeFormats({ formats }).map((item) => item.format_id)).toEqual(['301'])
  })

  it.each([false, undefined])('rejects non-live metadata: %s', async (is_live) => {
    const result = await resolveYouTube('youtu.be/abcdefghijk', deps({ runYtDlp: async () => ({ ...fixture, is_live }) }))
    expect(!result.ok && result.failure.code).toBe('not-live')
  })

  it('rejects ended/live replay metadata even with a stale live flag', async () => {
    const result = await resolveYouTube('youtu.be/abcdefghijk', deps({ runYtDlp: async () => ({ ...fixture, live_status: 'was_live' }) }))
    expect(!result.ok && result.failure.code).toBe('not-live')
  })

  it('classifies extractor errors without leaking credentials or signed URLs', async () => {
    for (const [message, code] of [
      ['Sign in to confirm you are not a bot', 'restricted'],
      ['not currently live', 'not-live'], ['HTTP 503', 'upstream-error'],
    ]) {
      const result = await resolveYouTube('youtu.be/abcdefghijk', deps({ runYtDlp: async () => { throw new Error(`${message} Cookie=secret https://media.invalid/live?token=private`) } }))
      expect(!result.ok && result.failure.code).toBe(code)
      expect(JSON.stringify(result)).not.toMatch(/secret|token=private|media.invalid/)
    }
  })

  it('returns structured failures for missing tools, missing formats and unavailable quality', async () => {
    const missing = await resolveYouTube('youtu.be/abcdefghijk', deps({ runYtDlp: undefined }))
    expect(!missing.ok && missing.failure.code).toBe('upstream-error')
    const empty = await resolveYouTube('youtu.be/abcdefghijk', deps({ runYtDlp: async () => ({ ...fixture, formats: [] }) }))
    expect(!empty.ok && empty.failure.code).toBe('needs-manual-url')
    const unavailable = await resolveYouTube('youtu.be/abcdefghijk', deps({ quality: 'missing' }))
    expect(!unavailable.ok && unavailable.failure.code).toBe('unsupported-url')
  })
})
