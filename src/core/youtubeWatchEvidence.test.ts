import { describe, expect, it } from 'vitest'
import {
  buildYouTubeWatchEvidence,
  YOUTUBE_WATCH_EVIDENCE_DOCS,
  type YouTubeManualHistoryStatus,
  type YouTubeManualWatchHistoryEvidence,
  type YouTubeWatchEvidenceInput,
} from './youtubeWatchEvidence'

const context: YouTubeWatchEvidenceInput = {
  accountRef: 'offline-account-a',
  videoId: 'offlineVid1',
  channelId: 'UC-offline-channel-a',
  authorized: true,
}

function manualEvidence(status: YouTubeManualHistoryStatus = 'found'): YouTubeManualWatchHistoryEvidence {
  return {
    source: 'youtube-watch-history-manual',
    scope: 'account-video',
    accountRef: 'offline-account-a',
    videoId: 'offlineVid1',
    status,
    checkedAt: 1_795_046_400_000,
  }
}

describe('YouTube personal watch evidence', () => {
  it('keeps history unreadable until the exact account and video are manually checked', () => {
    const state = buildYouTubeWatchEvidence(context)
    expect(state).toMatchObject({
      platform: 'youtube',
      accountRef: context.accountRef,
      videoId: context.videoId,
      channelId: context.channelId,
      history: {
        scope: 'account-video',
        status: 'unreadable',
        source: null,
        checkedAt: null,
        apiStatus: 'unavailable',
        apiReason: 'watchHistoryNotAccessible',
      },
      personalSessionTime: { scope: 'account-video', status: 'unavailable' },
    })
    expect(state.history.message).toContain('手工核对')
    expect(buildYouTubeWatchEvidence({ ...context, manualEvidence: null })).toEqual(state)
  })

  it.each([null, '', '   '])('requires an account reference even with manual evidence: %s', (accountRef) => {
    const state = buildYouTubeWatchEvidence({ ...context, accountRef, manualEvidence: manualEvidence() })
    expect(state.history).toMatchObject({ status: 'unauthorized', source: null, checkedAt: null })
  })

  it('does not treat playback login or an existing sample as authorization', () => {
    const state = buildYouTubeWatchEvidence({ ...context, authorized: false, manualEvidence: manualEvidence() })
    expect(state.history).toMatchObject({ status: 'unauthorized', source: null, checkedAt: null })
    expect(state.history.message).toContain('播放取流登录不等于')
  })

  it.each([null, '', 'UC-offline-channel-a', 'https://www.youtube.com/watch?v=offlineVid1', 'invalid?vid'])(
    'requires a formal video ID and never substitutes a channel or URL: %s',
    (videoId) => {
      const state = buildYouTubeWatchEvidence({ ...context, videoId, manualEvidence: manualEvidence() })
      expect(state.history).toMatchObject({ status: 'unreadable', source: null, checkedAt: null })
      expect(state.officialEntries.video).toBeNull()
    },
  )

  it.each(['history-disabled', 'unreadable', 'not-found', 'found'] as const)(
    'accepts an explicit scoped manual result: %s',
    (status) => {
      const evidence = manualEvidence(status)
      const state = buildYouTubeWatchEvidence({ ...context, manualEvidence: evidence })
      expect(state.history).toMatchObject({
        status,
        source: 'youtube-watch-history-manual',
        checkedAt: evidence.checkedAt,
      })
      expect(state.personalSessionTime.status).toBe('unavailable')
    },
  )

  it('explains that disabled history prevents new records and Time watched statistics', () => {
    const state = buildYouTubeWatchEvidence({ ...context, manualEvidence: manualEvidence('history-disabled') })
    expect(state.history.message).toContain('关闭期间观看的视频不会进入历史')
    expect(state.history.message).toContain('Time watched 统计不可用')
  })

  it('does not interpret missing history as no viewing or a found entry as minutes', () => {
    const missing = buildYouTubeWatchEvidence({ ...context, manualEvidence: manualEvidence('not-found') })
    const found = buildYouTubeWatchEvidence({ ...context, manualEvidence: manualEvidence() })
    expect(missing.history.message).toContain('不能据此断言未观看')
    expect(found.history.message).toContain('不证明本场观看分钟或观看完成')
  })

  it.each(['history-disabled', 'unreadable', 'not-found', 'found'] as const)(
    'discards every prior result when the account changes: %s',
    (status) => {
      const state = buildYouTubeWatchEvidence({
        ...context,
        accountRef: 'offline-account-b',
        manualEvidence: manualEvidence(status),
      })
      expect(state.accountRef).toBe('offline-account-b')
      expect(state.history).toMatchObject({ status: 'unreadable', source: null, checkedAt: null })
      expect(state.history.message).toContain('不匹配')
    },
  )

  it.each(['history-disabled', 'unreadable', 'not-found', 'found'] as const)(
    'discards every prior result for a new broadcast on the same channel: %s',
    (status) => {
      const state = buildYouTubeWatchEvidence({
        ...context,
        videoId: 'offlineVid2',
        manualEvidence: manualEvidence(status),
      })
      expect(state.channelId).toBe(context.channelId)
      expect(state.videoId).toBe('offlineVid2')
      expect(state.history).toMatchObject({ status: 'unreadable', source: null, checkedAt: null })
      expect(state.officialEntries.video).toBe('https://www.youtube.com/watch?v=offlineVid2')
    },
  )

  it.each([
    { source: 'youtube-time-watched' },
    { source: 'youtube-creator-analytics' },
    { source: 'youtube-playlist-items' },
    { source: 'local-playback' },
    { source: undefined },
    { scope: 'account-recent' },
    { scope: 'channel-content-aggregate' },
    { scope: undefined },
    { status: 'verified' },
    { status: 'unauthorized' },
    { status: 'toString' },
    { checkedAt: undefined },
    { checkedAt: Number.NaN },
    { checkedAt: Number.POSITIVE_INFINITY },
    { checkedAt: 0 },
    { checkedAt: -1 },
    { checkedAt: 1.5 },
    { checkedAt: Number.MAX_SAFE_INTEGER + 1 },
    { checkedAt: '2026-11-19' },
  ])('rejects evidence with an invalid source, scope, result or timestamp: %j', (override) => {
    const evidence = { ...manualEvidence(), ...override } as unknown as YouTubeManualWatchHistoryEvidence
    const state = buildYouTubeWatchEvidence({ ...context, manualEvidence: evidence })
    expect(state.history).toMatchObject({ status: 'unreadable', source: null, checkedAt: null })
  })

  it('keeps recent personal totals and creator reports explicitly outside the session scope', () => {
    const state = buildYouTubeWatchEvidence({ ...context, manualEvidence: manualEvidence() })
    expect(state.timeWatched).toMatchObject({ scope: 'account-recent', status: 'manual-only' })
    expect(state.timeWatched.message).toContain('过去 7 天')
    expect(state.timeWatched.message).toContain('电脑观看时长存在误报')
    expect(state.creatorAnalytics).toMatchObject({ scope: 'channel-content-aggregate', status: 'not-personal' })
    expect(state.creatorAnalytics.message).toContain('筛选本场视频后仍不是当前观众的个人时长')
  })

  it.each(['history-disabled', 'unreadable', 'not-found', 'found'] as const)(
    'never emits a numeric watch duration or copies a supplied readout: %s',
    (status) => {
      const evidence = { ...manualEvidence(status), minutes: 30, seconds: 1_800 }
      const state = buildYouTubeWatchEvidence({ ...context, manualEvidence: evidence })
      expect(state.personalSessionTime.status).toBe('unavailable')
      expect(JSON.stringify(state)).not.toMatch(/"(?:minutes|seconds|estimatedMinutesWatched)":/)
      expect(state.history).not.toHaveProperty('minutes')
    },
  )

  it('returns dated official documentation and stable manual entry points without an account URL claim', () => {
    const state = buildYouTubeWatchEvidence(context)
    expect(state.documentation).toEqual({
      checkedOn: '2026-11-19',
      watchHistory: 'https://support.google.com/youtube/answer/95725',
      timeWatched: 'https://support.google.com/youtube/answer/9052667',
      reportsQuery: 'https://developers.google.com/youtube/analytics/reference/reports/query',
      metrics: 'https://developers.google.com/youtube/analytics/metrics',
      playlistItems: 'https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list',
    })
    expect(state.officialEntries).toEqual({
      watchHistory: 'https://myactivity.google.com/product/youtube',
      video: 'https://www.youtube.com/watch?v=offlineVid1',
      timeWatched: YOUTUBE_WATCH_EVIDENCE_DOCS.timeWatched,
      creatorAnalytics: YOUTUBE_WATCH_EVIDENCE_DOCS.reportsQuery,
    })
  })

  it('is deterministic, retains the supplied observation time and does not mutate inputs', () => {
    const evidence = Object.freeze(manualEvidence())
    const input = Object.freeze({ ...context, channelId: undefined, manualEvidence: evidence })
    const state = buildYouTubeWatchEvidence(input)
    expect(state).toEqual(buildYouTubeWatchEvidence(input))
    expect(state.channelId).toBeNull()
    expect(state.history.checkedAt).toBe(evidence.checkedAt)
    expect(evidence.status).toBe('found')
    expect(Object.isFrozen(state.documentation)).toBe(true)
  })
})
