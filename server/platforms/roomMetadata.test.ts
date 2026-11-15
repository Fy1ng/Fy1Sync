import { describe, expect, it } from 'vitest'
import { bilibiliMetadata, douyinMetadata, douyuMetadata, huyaMetadata, metadataTime, twitchMetadata, youtubeMetadata } from './roomMetadata'

const NOW = Date.parse('2026-11-15T00:00:00Z')
const CHANNEL = 'UC1234567890123456789012'
const html = (name: string, value: unknown) => `<script>var ${name} = ${JSON.stringify(value)};</script>`

describe('public room metadata normalization', () => {
  it('reads offline Douyu identity, title and the platform last start without treating failure as offline', () => {
    const data = { room_id: 100, show_status: 2, show_time: '2026-11-14 20:00:00', nickname: '主播', room_name: '标题', avatar: { big: 'https://apic.douyucdn.cn/avatar.jpg' } }
    expect(douyuMetadata({ error: 0, data }, '100', NOW)).toMatchObject({ status: 'offline', nickname: '主播', title: '标题', lastStartedAt: Date.parse('2026-11-14T12:00:00Z') })
    expect(() => douyuMetadata({ error: 0, data: { ...data, room_id: 200 } }, '100', NOW)).toThrow()
    expect(() => douyuMetadata({ error: 0, data: { online: 0 } }, '100', NOW)).toThrow()
    expect(douyuMetadata({ error: 0, data: { ...data, show_status: 1, videoLoop: 1 } }, '100', NOW).status).toBe('replay')
  })

  it('reads Bilibili canonical rooms and excludes untrusted image URLs', () => {
    const room_info = { room_id: 123, live_status: 2, title: '轮播标题', live_start_time: 1794614400 }
    const anchor_info = { base_info: { uname: '主播甲', face: 'https://attacker.example/image.svg' } }
    expect(bilibiliMetadata({ code: 0, data: { room_info, anchor_info } }, NOW)).toMatchObject({ roomId: '123', nickname: '主播甲', status: 'replay', avatarUrl: null })
    expect(() => bilibiliMetadata({ code: -352, data: {} }, NOW)).toThrow()
  })

  it('extracts Huya static JSON without executing scripts, including offline profiles', () => {
    const page = html('TT_ROOM_DATA', { profileRoom: 123, state: 'OFF', introduction: '标题', startTime: NOW / 1000 - 60 })
      + html('TT_PROFILE_INFO', { nick: '主播乙', avatar: 'https://huyaimg.msstatic.com/avatar.jpg' })
    expect(huyaMetadata(page, NOW)).toMatchObject({ roomId: '123', status: 'offline', nickname: '主播乙', lastStartedAt: NOW - 60_000 })
    expect(() => huyaMetadata('<script>globalThis.executed = true</script>', NOW)).toThrow()
  })

  it('collects Huya replay rooms as replay rather than treating them as acquisition failures', () => {
    const page = html('TT_ROOM_DATA', { profileRoom: 10188, state: 'REPLAY', isReplay: true, introduction: '回放标题', startTime: NOW / 1000 - 60 })
      + html('TT_PROFILE_INFO', { nick: '主播甲', avatar: 'https://huyaimg.msstatic.com/avatar.jpg' })
    expect(huyaMetadata(page, NOW)).toMatchObject({ roomId: '10188', status: 'replay', nickname: '主播甲', title: '回放标题',
      avatarUrl: 'https://huyaimg.msstatic.com/avatar.jpg', lastStartedAt: NOW - 60_000 })
  })

  it('keeps a Twitch API error distinct from a channel with a null stream', () => {
    const user = { id: '123', login: 'test', displayName: '测试主播', stream: null, broadcastSettings: { title: '上次标题' } }
    expect(twitchMetadata({ data: { user } }, 'test', NOW)).toMatchObject({ nickname: '测试主播', status: 'offline', title: '上次标题' })
    expect(() => twitchMetadata({ data: { user }, errors: [{ message: 'rate limited' }] }, 'test', NOW)).toThrow()
    expect(() => twitchMetadata({ data: { user: { ...user, stream: undefined } } }, 'test', NOW)).toThrow()
  })

  it('reads Douyin offline data without requiring a playable stream', () => {
    expect(douyinMetadata({ webRoom: '123', status: 4, title: '上次直播', nickname: '主播丙', stream: {}, h264: {} }, NOW)).toMatchObject({ status: 'offline', nickname: '主播丙', title: '上次直播', lastStartedAt: null })
    expect(() => douyinMetadata({ webRoom: '123', status: 0, stream: {}, h264: {} }, NOW)).toThrow()
  })

  it('reads the YouTube broadcast start and stable channel identity from a watch page', () => {
    const player = { videoDetails: { channelId: CHANNEL, isLiveContent: true, author: '频道甲', title: '直播标题' },
      microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true, startTimestamp: '2026-11-14T23:00:00Z' } } } }
    expect(youtubeMetadata(html('ytInitialPlayerResponse', player), 'https://www.youtube.com/watch?v=12345678901', NOW)).toMatchObject({ roomId: CHANNEL, status: 'live', lastStartedAt: NOW - 3_600_000 })
    expect(() => youtubeMetadata('<html>请完成验证</html>', 'https://www.youtube.com/@test/live', NOW)).toThrow()
  })

  it('requires a selected YouTube streams tab and ignores live recommendations outside it', () => {
    const initial = { metadata: { channelMetadataRenderer: { externalId: CHANNEL, title: '频道甲' } },
      contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { videoRenderer: { title: { simpleText: '最近直播标题' } } } } }] } },
      recommendations: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }
    expect(youtubeMetadata(html('ytInitialData', initial), 'https://www.youtube.com/@test/streams', NOW)).toMatchObject({ status: 'offline', nickname: '频道甲', title: '最近直播标题', lastStartedAt: null })
    expect(() => youtubeMetadata(html('ytInitialData', initial), 'https://www.youtube.com/@test/live', NOW)).toThrow()
  })

  it('rejects missing, invalid, future and ambiguous local start times', () => {
    for (const value of [undefined, null, '', 0, -1, Infinity, NOW + 1, '2026-11-14', 'yesterday']) expect(metadataTime(value, NOW)).toBeNull()
    expect(metadataTime('2026-11-14 10:00:00', NOW)).toBe(Date.parse('2026-11-14T02:00:00Z'))
    expect(metadataTime((NOW - 1000) / 1000, NOW)).toBe(NOW - 1000)
  })
})
