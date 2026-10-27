import { describe, expect, it } from 'vitest'
import { highestHlsVariant } from './hlsVariant'

const base = 'https://video.ttvnw.net/live/channel/master.m3u8?signature=PRIVATE'
const low = '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,FRAME-RATE=30,CODECS="avc1.4D401E,mp4a.40.2"\nlow.m3u8'
const high = '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60,CODECS="avc1.64002A,mp4a.40.2"\nhigh.m3u8?signature=PRIVATE_VARIANT'
const audio = '#EXT-X-STREAM-INF:BANDWIDTH=99999999,CODECS="mp4a.40.2",VIDEO="audio_only"\naudio.m3u8'

describe('highest HLS video rendition', () => {
  it.each([[audio, low, high], [high, low, audio]])('chooses the highest video regardless of master order', (...variants) => {
    expect(highestHlsVariant(['#EXTM3U', ...variants].join('\n'), base)).toEqual({
      url: 'https://video.ttvnw.net/live/channel/high.m3u8?signature=PRIVATE_VARIANT',
      width: 1920, height: 1080, fps: 60, bandwidth: 6000000,
    })
  })

  it('prefers frame rate at equal resolution, then bandwidth at equal frame rate', () => {
    const body = ['#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,FRAME-RATE=30', '30.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,FRAME-RATE=60', '60-low.m3u8', high,
    ].join('\n')
    expect(highestHlsVariant(body, base)?.url).toContain('/high.m3u8')
  })

  it('uses the supplied final URL after a redirect for relative rendition paths', () => {
    expect(highestHlsVariant('#EXTM3U\n' + high, 'https://other.ttvnw.net/redirected/master.m3u8')?.url)
      .toBe('https://other.ttvnw.net/redirected/high.m3u8?signature=PRIVATE_VARIANT')
  })

  it('leaves an already-selected media playlist unchanged', () => {
    expect(highestHlsVariant('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n', base)).toBeNull()
  })

  it.each([
    '#EXTM3U\n' + audio,
    '<html>Service unavailable</html>',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=bad\nbad.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080,FRAME-RATE=NaN\nbad.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,BANDWIDTH=200,RESOLUTION=1920x1080\nbad.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080\nfile:///private.m3u8',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1920x1080\nhttps://user:pass@video.ttvnw.net/a',
  ])('rejects a malformed or video-less playlist', body => {
    expect(() => highestHlsVariant(body, base)).toThrow()
  })
})
