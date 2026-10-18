import { describe, expect, it } from 'vitest'
import {
  isPlaylistContent,
  registeredUrlFor,
  rewritePlaylist,
  rewriteUriAttribute,
  shouldRewrite,
} from './hlsRewrite'

const upstreams = new Map<string, string>()
const options = {
  baseUrl: new URL('https://video-weaver.ttvnw.net/v1/playlist/abc.m3u8'),
  register: (absolute: string): string => {
    const id = 'app://app/media/' + String(upstreams.size + 1)
    upstreams.set(id, absolute)
    return id
  },
}

/** Pull the original upstream URL from the test registration table. */
function upstreamOf(line: string): string {
  return upstreams.get(line) ?? ''
}

describe('registeredUrlFor', () => {
  it('absolutises a relative URI against the playlist URL', () => {
    const url = registeredUrlFor('seg-1.ts', options)
    expect(upstreamOf(url)).toBe('https://video-weaver.ttvnw.net/v1/playlist/seg-1.ts')
  })

  it('keeps an absolute URI intact', () => {
    const url = registeredUrlFor('https://cdn.ttvnw.net/x/seg-2.ts', options)
    expect(upstreamOf(url)).toBe('https://cdn.ttvnw.net/x/seg-2.ts')
  })

  it('resolves a root-relative URI against the origin', () => {
    expect(upstreamOf(registeredUrlFor('/abs/seg.ts', options))).toBe(
      'https://video-weaver.ttvnw.net/abs/seg.ts',
    )
  })

  it('preserves signed query parameters through registration', () => {
    const url = registeredUrlFor('seg.ts?token=a&b=c', options)
    expect(upstreamOf(url)).toBe('https://video-weaver.ttvnw.net/v1/playlist/seg.ts?token=a&b=c')
  })

  it('passes only the resolved target to the main registration callback', () => {
    const targets: string[] = []
    const url = registeredUrlFor('seg.ts', { ...options, register: (target) => { targets.push(target); return 'app://app/media/opaque' } })
    expect(url).toBe('app://app/media/opaque')
    expect(targets).toEqual(['https://video-weaver.ttvnw.net/v1/playlist/seg.ts'])
  })
})

describe('rewritePlaylist', () => {
  it('rewrites media segment lines and leaves tags alone', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXTINF:2.000,',
      'seg-1.ts',
      '#EXTINF:2.000,',
      'https://other.ttvnw.net/seg-2.ts',
      '',
    ].join('\n')

    const lines = rewritePlaylist(input, options).split('\n')
    expect(lines[0]).toBe('#EXTM3U')
    expect(lines[1]).toBe('#EXT-X-VERSION:3')
    expect(lines[4]).toContain('app://app/media/')
    expect(upstreamOf(lines[4]!)).toBe('https://video-weaver.ttvnw.net/v1/playlist/seg-1.ts')
    expect(upstreamOf(lines[6]!)).toBe('https://other.ttvnw.net/seg-2.ts')
  })

  it('rewrites variant playlist URIs in a master playlist', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080',
      'chunked/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
      '720p60/index.m3u8',
    ].join('\n')

    const lines = rewritePlaylist(input, options).split('\n')
    expect(upstreamOf(lines[2]!)).toBe('https://video-weaver.ttvnw.net/v1/playlist/chunked/index.m3u8')
    expect(upstreamOf(lines[4]!)).toBe('https://video-weaver.ttvnw.net/v1/playlist/720p60/index.m3u8')
  })

  it('rewrites URI attributes on EXT-X-KEY and EXT-X-MAP', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.ttvnw.net/k1",IV=0x1234',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
      '#EXTINF:2.0,',
      'seg.m4s',
    ].join('\n')

    const lines = rewritePlaylist(input, options).split('\n')
    // Order and unknown attributes are preserved; only the URI value changes.
    expect(lines[1]).toMatch(/^#EXT-X-KEY:METHOD=AES-128,URI="[^"]+",IV=0x1234$/)
    expect(lines[1]).toContain('METHOD=AES-128')
    expect(lines[1]).toContain('IV=0x1234')
    const keyUri = /URI="([^"]+)"/.exec(lines[1]!)![1]!
    expect(upstreamOf(keyUri)).toBe('https://keys.ttvnw.net/k1')

    expect(lines[2]).toContain('BYTERANGE="720@0"')
    const mapUri = /URI="([^"]+)"/.exec(lines[2]!)![1]!
    expect(upstreamOf(mapUri)).toBe('https://video-weaver.ttvnw.net/v1/playlist/init.mp4')
  })

  it('rewrites low-latency PART and PRELOAD-HINT URIs', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-PART:DURATION=0.5,URI="part-1.ts",INDEPENDENT=YES',
      '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-2.ts"',
      '#EXT-X-RENDITION-REPORT:URI="../720p/index.m3u8",LAST-MSN=42',
    ].join('\n')

    const lines = rewritePlaylist(input, options).split('\n')
    expect(lines[1]).toContain('INDEPENDENT=YES')
    expect(upstreamOf(/URI="([^"]+)"/.exec(lines[1]!)![1]!)).toBe(
      'https://video-weaver.ttvnw.net/v1/playlist/part-1.ts',
    )
    expect(upstreamOf(/URI="([^"]+)"/.exec(lines[3]!)![1]!)).toBe(
      'https://video-weaver.ttvnw.net/v1/720p/index.m3u8',
    )
  })

  it('rewrites EXT-X-MEDIA audio renditions', () => {
    const input =
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"'
    const lines = rewritePlaylist(input, options).split('\n')
    expect(lines[1]).toContain('GROUP-ID="aac"')
    expect(lines[1]).toContain('DEFAULT=YES')
    expect(upstreamOf(/URI="([^"]+)"/.exec(lines[1]!)![1]!)).toBe(
      'https://video-weaver.ttvnw.net/v1/playlist/audio/en.m3u8',
    )
  })

  it('leaves an EXT-X-MEDIA entry without a URI untouched', () => {
    const line = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES'
    expect(rewritePlaylist(`#EXTM3U\n${line}`, options).split('\n')[1]).toBe(line)
  })

  it('preserves blank lines and comment lines', () => {
    const input = '#EXTM3U\n\n## a comment\n#EXTINF:2.0,\nseg.ts'
    const lines = rewritePlaylist(input, options).split('\n')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('## a comment')
  })

  it('preserves CRLF-terminated playlists without doubling separators', () => {
    const output = rewritePlaylist('#EXTM3U\r\n#EXTINF:2.0,\r\nseg.ts\r\n', options)
    expect(output.split('\n')[2]).toContain('app://app/media/')
    expect(output).not.toContain('\r\r')
  })

  it('keeps EXT-X-ENDLIST and other terminal tags', () => {
    const output = rewritePlaylist('#EXTM3U\n#EXTINF:2.0,\nseg.ts\n#EXT-X-ENDLIST', options)
    expect(output.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })
})

describe('rewriteUriAttribute', () => {
  it('escapes a double quote in the produced URL', () => {
    const line = rewriteUriAttribute('#EXT-X-KEY:URI="k?a=%22b%22"', options)
    // The rewritten value must not contain a raw quote that would end the attribute early.
    const value = /URI="([^"]*)"/.exec(line)![1]!
    expect(value).not.toContain('"')
  })

  it('returns the line unchanged when there is no URI attribute', () => {
    expect(rewriteUriAttribute('#EXT-X-KEY:METHOD=NONE', options)).toBe('#EXT-X-KEY:METHOD=NONE')
  })
})

describe('isPlaylistContent / shouldRewrite', () => {
  it('detects a playlist by its magic line', () => {
    expect(isPlaylistContent('#EXTM3U\n#EXT-X-VERSION:3')).toBe(true)
    expect(isPlaylistContent('﻿#EXTM3U')).toBe(true)
    expect(isPlaylistContent('  \n#EXTM3U')).toBe(true)
    expect(isPlaylistContent('not a playlist')).toBe(false)
    expect(isPlaylistContent('')).toBe(false)
  })

  it('rewrites an extensionless Twitch variant playlist served as text/plain', () => {
    expect(
      shouldRewrite(
        new URL('https://video-weaver.ttvnw.net/v1/playlist/CvYE...signed'),
        'text/plain',
        '#EXTM3U\n#EXTINF:2.0,\nseg.ts',
      ),
    ).toBe(true)
  })

  it('rewrites by path when no body is available (HEAD)', () => {
    expect(
      shouldRewrite(new URL('https://cdn.example.com/live/index.m3u8'), 'application/octet-stream'),
    ).toBe(true)
    expect(shouldRewrite('https://cdn.example.com/live/seg-1.ts', 'video/mp2t')).toBe(false)
  })

  it('rewrites by content type when no body is available', () => {
    expect(shouldRewrite(new URL('https://cdn.example.com/signed/xyz'), 'audio/mpegurl')).toBe(true)
  })

  it('does not rewrite a media segment', () => {
    expect(
      shouldRewrite(new URL('https://cdn.example.com/live/seg-1.ts'), 'video/mp2t', 'binary'),
    ).toBe(false)
  })

  it('lets the body override a misleading playlist content type', () => {
    // A CDN mislabelling an mp4 as mpegurl must not get its binary line-rewritten.
    expect(
      shouldRewrite(
        new URL('https://cdn.example.com/v.mp4'),
        'application/vnd.apple.mpegurl',
        'not a playlist body',
      ),
    ).toBe(false)
  })

  it('lets the body override a misleading binary content type', () => {
    expect(
      shouldRewrite(
        new URL('https://cdn.example.com/live/index.m3u8'),
        'video/mp2t',
        '#EXTM3U\nseg.ts',
      ),
    ).toBe(true)
  })
})
