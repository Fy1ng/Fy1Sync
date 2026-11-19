export const YOUTUBE_WATCH_EVIDENCE_DOCS = Object.freeze({
  checkedOn: '2026-11-19',
  watchHistory: 'https://support.google.com/youtube/answer/95725',
  timeWatched: 'https://support.google.com/youtube/answer/9052667',
  reportsQuery: 'https://developers.google.com/youtube/analytics/reference/reports/query',
  metrics: 'https://developers.google.com/youtube/analytics/metrics',
  playlistItems: 'https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list',
})

export type YouTubeManualHistoryStatus = 'history-disabled' | 'unreadable' | 'not-found' | 'found'
export type YouTubeHistoryStatus = 'unauthorized' | YouTubeManualHistoryStatus

export interface YouTubeManualWatchHistoryEvidence {
  source: 'youtube-watch-history-manual'
  scope: 'account-video'
  accountRef: string
  videoId: string
  status: YouTubeManualHistoryStatus
  checkedAt: number
}

export interface YouTubeWatchEvidenceInput {
  accountRef: string | null
  videoId: string | null
  channelId?: string | null
  authorized: boolean
  manualEvidence?: YouTubeManualWatchHistoryEvidence | null
}

export interface YouTubeWatchEvidenceState {
  platform: 'youtube'
  accountRef: string | null
  videoId: string | null
  channelId: string | null
  history: {
    scope: 'account-video'
    status: YouTubeHistoryStatus
    source: 'youtube-watch-history-manual' | null
    checkedAt: number | null
    message: string
    apiStatus: 'unavailable'
    apiReason: 'watchHistoryNotAccessible'
  }
  personalSessionTime: {
    scope: 'account-video'
    status: 'unavailable'
    message: string
  }
  timeWatched: {
    scope: 'account-recent'
    status: 'manual-only'
    message: string
  }
  creatorAnalytics: {
    scope: 'channel-content-aggregate'
    status: 'not-personal'
    message: string
  }
  officialEntries: {
    watchHistory: string
    video: string | null
    timeWatched: string
    creatorAnalytics: string
  }
  documentation: typeof YOUTUBE_WATCH_EVIDENCE_DOCS
}

const HISTORY_MESSAGES: Record<YouTubeManualHistoryStatus, string> = {
  'history-disabled': '观看历史已关闭，关闭期间观看的视频不会进入历史，Time watched 统计不可用',
  unreadable: '未能读取观看历史，无法确认是否记录了本场视频',
  'not-found': '未找到本场视频的历史记录，记录可能已删除或关闭，不能据此断言未观看',
  found: '已找到本场视频的历史记录，不证明本场观看分钟或观看完成',
}

export function buildYouTubeWatchEvidence(input: YouTubeWatchEvidenceInput): YouTubeWatchEvidenceState {
  const validVideoId = typeof input.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(input.videoId)
  let status: YouTubeHistoryStatus = 'unreadable'
  let source: 'youtube-watch-history-manual' | null = null
  let checkedAt: number | null = null
  let message = '请在官方观看历史页面手工核对当前账号和本场视频'
  const evidence = input.manualEvidence

  if (input.authorized !== true || !input.accountRef?.trim()) {
    status = 'unauthorized'
    message = '尚未授权读取观看历史，请到官方页面手工核对当前账号和本场视频'
  } else if (!validVideoId) {
    message = '当前视频待确认，请在官方观看历史中核对'
  } else if (evidence) {
    if (evidence.accountRef !== input.accountRef || evidence.videoId !== input.videoId) {
      message = '观看记录与当前账号或视频不匹配，请重新核对'
    } else if (
      evidence.source !== 'youtube-watch-history-manual'
      || evidence.scope !== 'account-video'
      || !Object.hasOwn(HISTORY_MESSAGES, evidence.status)
      || !Number.isSafeInteger(evidence.checkedAt)
      || evidence.checkedAt <= 0
    ) {
      message = '观看记录不完整，请重新核对'
    } else {
      status = evidence.status
      source = evidence.source
      checkedAt = evidence.checkedAt
      message = HISTORY_MESSAGES[evidence.status]
    }
  }

  return {
    platform: 'youtube',
    accountRef: input.accountRef,
    videoId: input.videoId,
    channelId: input.channelId ?? null,
    history: {
      scope: 'account-video',
      status,
      source,
      checkedAt,
      message,
      apiStatus: 'unavailable',
      apiReason: 'watchHistoryNotAccessible',
    },
    personalSessionTime: {
      scope: 'account-video',
      status: 'unavailable',
      message: '已核验的官方接口未提供个人账号在本场视频实际观看的分钟. 播放进度, 历史条目和频道汇总均不能认证个人本场时长.',
    },
    timeWatched: {
      scope: 'account-recent',
      status: 'manual-only',
      message: 'YouTube App 中点击头像，打开「时间管理」的「Time watched」，可查看今日、昨日和过去 7 天总量，不提供单场时长',
    },
    creatorAnalytics: {
      scope: 'channel-content-aggregate',
      status: 'not-personal',
      message: 'reports.query 需要独立授权, ids 指定创作者频道或内容所有者. estimatedMinutesWatched 是频道, 视频或播放列表的观众汇总, 筛选本场视频后仍不是当前观众的个人时长.',
    },
    officialEntries: {
      watchHistory: 'https://myactivity.google.com/product/youtube',
      video: validVideoId ? `https://www.youtube.com/watch?v=${input.videoId}` : null,
      timeWatched: YOUTUBE_WATCH_EVIDENCE_DOCS.timeWatched,
      creatorAnalytics: YOUTUBE_WATCH_EVIDENCE_DOCS.reportsQuery,
    },
    documentation: YOUTUBE_WATCH_EVIDENCE_DOCS,
  }
}
