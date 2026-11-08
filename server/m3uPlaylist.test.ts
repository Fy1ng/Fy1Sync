import { describe, expect, it } from 'vitest'
import { parseM3u } from './m3uPlaylist'

describe('M3U channel import', () => {
  it('keeps backup channels and scopes headers to one entry', () => {
    const parsed = parseM3u('\uFEFF#EXTM3U\r\n# a comment\r\n#EXTINF:-1 tvg-name="A,B" group-title="体育,高清",频道,高清\r\n#EXTVLCOPT:http-referrer=https://player.example/\r\n#EXTVLCOPT:http-user-agent=Test Player\r\nhttp://relay.example:4022/rtp/233.1.2.3:5140\r\n#EXTINF:-1,频道,高清\r\nhttps://cdn.example/backup')
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.entries[0]).toMatchObject({ name: '频道,高清', group: '体育,高清', headers: { Referer: 'https://player.example/', 'User-Agent': 'Test Player' } })
    expect(parsed.entries[1]?.headers).toEqual({})
  })
  it('resolves relative URLs against the final remote list location and skips other schemes', () => {
    const parsed = parseM3u('#EXTM3U\n#EXTINF:-1,本地\nfile:///secret\n#EXTINF:-1,频道\n../live.ts', 'https://cdn.example/lists/current.m3u')
    expect(parsed.entries).toEqual([{ name: '频道', group: '', url: 'https://cdn.example/live.ts', headers: {} }])
  })
  it('distinguishes HLS from a channel list even with the same extension', () => {
    expect(parseM3u('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts').kind).toBe('hls')
    expect(parseM3u('#EXTM3U\n#EXTINF:-1,台\nhttps://cdn.example/live.m3u8').kind).toBe('channels')
    expect(() => parseM3u('<html>not a list</html>')).toThrow('没有可用')
  })
})
