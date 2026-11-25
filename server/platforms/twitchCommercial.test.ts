import { describe, expect, it } from 'vitest'
import { detectTwitchCommercialBreak } from './twitchCommercial'

describe('detectTwitchCommercialBreak', () => {
  it('returns null for master playlists and non-HLS payloads', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,VIDEO="chunked"',
      'https://video-weaver.ttvnw.net/v1/playlist/source.m3u8',
    ].join('\n')
    expect(detectTwitchCommercialBreak(master)).toBeNull()
    expect(detectTwitchCommercialBreak('not a playlist')).toBeNull()
  })

  it('returns false for normal live Twitch playlists', () => {
    const live = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:00.000Z',
      '#EXTINF:2.000,live',
      'seg100.mp4',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:02.000Z',
      '#EXTINF:2.000,live',
      'seg101.mp4',
    ].join('\n')
    expect(detectTwitchCommercialBreak(live)).toBe(false)
  })

  it('detects stitched preroll and midroll ads from EXT-X-DATERANGE and Amazon segment titles', () => {
    const stitched = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:200',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:00.000Z',
      '#EXTINF:2.000,live',
      'seg200.mp4',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-DATERANGE:ID="stitched-ad-12345",CLASS="twitch-stitched-ad",START-DATE="2026-11-25T14:00:02.000Z",DURATION=30.0,X-TV-TWITCH-AD-ROLL-TYPE="midroll"',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:02.000Z',
      '#EXTINF:2.000,Amazon|98765',
      'ad0.mp4',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:04.000Z',
      '#EXTINF:2.000,Amazon|98765',
      'ad1.mp4',
    ].join('\n')
    expect(detectTwitchCommercialBreak(stitched)).toBe(true)
  })

  it('detects daterange-marked Twitch ads even when EXTINF titles omit Amazon', () => {
    const withoutTitle = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-DATERANGE:ID="ad-1",X-TV-TWITCH-AD-COMMERCIAL-ID="abc",START-DATE="2026-11-25T14:10:00.000Z",DURATION=15.0',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:10:06.000Z',
      '#EXTINF:2.000,',
      'slate3.mp4',
    ].join('\n')
    expect(detectTwitchCommercialBreak(withoutTitle)).toBe(true)
  })

  it('clears commercial break state as soon as the trailing segment resumes live broadcast', () => {
    const recovered = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-DATERANGE:ID="stitched-ad-12345",CLASS="twitch-stitched-ad",START-DATE="2026-11-25T14:00:00.000Z",DURATION=15.0',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:13.000Z',
      '#EXTINF:2.000,Amazon|98765',
      'ad_last.mp4',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-PROGRAM-DATE-TIME:2026-11-25T14:00:15.000Z',
      '#EXTINF:2.000,live',
      'live_resumed.mp4',
    ].join('\n')
    expect(detectTwitchCommercialBreak(recovered)).toBe(false)
  })
})
