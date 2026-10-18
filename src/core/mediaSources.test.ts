import { describe, expect, it } from 'vitest'
import { isProxied, parseSourceInput, proxyUrl, toDescriptor } from './mediaSources'

function expectOk(input: string) {
  const result = parseSourceInput(input)
  if (!result.ok) throw new Error(`expected ${input} to parse, got ${result.message}`)
  return result
}

describe('parseSourceInput', () => {
  it('recognises a Twitch channel page and marks it for resolution', () => {
    const result = expectOk('https://www.twitch.tv/esl_csgo')
    expect(result.platform).toBe('twitch')
    expect(result.channel).toBe('esl_csgo')
    expect(result.needsResolve).toBe(true)
    expect(result.kind).toBe('hls')
    expect(result.label).toBe('Twitch / esl_csgo')
  })

  it('accepts a Twitch link without a scheme or with extra path', () => {
    expect(expectOk('twitch.tv/esl_csgo').channel).toBe('esl_csgo')
    expect(expectOk('https://m.twitch.tv/esl_csgo/videos').channel).toBe('esl_csgo')
  })

  it('recognises a Douyu room', () => {
    const result = expectOk('https://www.douyu.com/9999')
    expect(result.platform).toBe('douyu')
    expect(result.channel).toBe('9999')
    expect(result.needsResolve).toBe(true)
  })

  it('keeps a Douyu vanity path as the channel for server-side mapping', () => {
    expect(expectOk('douyu.com/dyshow').channel).toBe('dyshow')
  })

  it('rejects a platform link with no channel', () => {
    const result = parseSourceInput('https://www.twitch.tv/')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-page')
  })

  it('accepts a direct HLS playlist', () => {
    const result = expectOk('https://cdn.example.com/live/index.m3u8?token=abc')
    expect(result.platform).toBe('direct')
    expect(result.kind).toBe('hls')
    expect(result.needsResolve).toBe(false)
    expect(result.suggestProxy).toBe(true)
  })

  it('accepts progressive files', () => {
    expect(expectOk('https://cdn.example.com/a.mp4').kind).toBe('progressive')
    expect(expectOk('https://cdn.example.com/a.webm').kind).toBe('progressive')
  })

  it('treats same-origin paths as local and needing no proxy', () => {
    const result = expectOk('/test-sources/countdown-00-45.mp4')
    expect(result.platform).toBe('test')
    expect(result.suggestProxy).toBe(false)
    expect(result.needsResolve).toBe(false)
  })

  it('accepts blob URLs from the file picker', () => {
    const result = expectOk('blob:http://127.0.0.1:5173/8f7c')
    expect(result.kind).toBe('file')
    expect(result.platform).toBe('file')
  })

  it('rejects an empty input', () => {
    const result = parseSourceInput('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('empty')
  })

  it('rejects unsupported schemes', () => {
    const result = parseSourceInput('rtmp://example.com/live/key')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported-scheme')
  })

  it('rejects a plain web page with a helpful message', () => {
    const result = parseSourceInput('https://example.com/some/article')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('unsupported-page')
    expect(result.message).toContain('.m3u8')
  })

  it('rejects DASH explicitly', () => {
    const result = parseSourceInput('https://example.com/stream.mpd')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('DASH')
  })
})

describe('proxy helpers', () => {
  it('encodes the target url', () => {
    expect(proxyUrl('https://a.example/x.m3u8?t=1&u=2')).toBe(
      '/api/media?url=https%3A%2F%2Fa.example%2Fx.m3u8%3Ft%3D1%26u%3D2',
    )
  })

  it('detects proxied urls', () => {
    expect(isProxied(proxyUrl('https://a.example/x.m3u8'))).toBe(true)
    expect(isProxied('https://a.example/x.m3u8')).toBe(false)
  })
})

describe('toDescriptor', () => {
  it('passes a direct url through', () => {
    const descriptor = toDescriptor(expectOk('https://cdn.example.com/a.m3u8'))
    expect(descriptor.url).toBe('https://cdn.example.com/a.m3u8')
    expect(descriptor.viaProxy).toBe(false)
  })

  it('wraps in the proxy when asked', () => {
    const descriptor = toDescriptor(expectOk('https://cdn.example.com/a.m3u8'), { viaProxy: true })
    expect(descriptor.url).toBe(proxyUrl('https://cdn.example.com/a.m3u8'))
    expect(descriptor.input).toBe('https://cdn.example.com/a.m3u8')
  })

  it('does not double-wrap an already proxied url', () => {
    const already = proxyUrl('https://cdn.example.com/a.m3u8')
    const descriptor = toDescriptor(expectOk('https://cdn.example.com/a.m3u8'), {
      url: already,
      viaProxy: true,
    })
    expect(descriptor.url).toBe(already)
  })

  it('carries the resolved url for platform sources', () => {
    const descriptor = toDescriptor(expectOk('https://www.twitch.tv/esl_csgo'), {
      url: 'https://usher.example/playlist.m3u8',
      viaProxy: true,
    })
    expect(descriptor.platform).toBe('twitch')
    expect(descriptor.input).toBe('https://www.twitch.tv/esl_csgo')
    expect(descriptor.url).toContain('usher.example')
  })
})
