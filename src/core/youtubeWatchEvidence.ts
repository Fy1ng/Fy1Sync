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
  'history-disabled': '人工核对显示观看历史已关闭. 关闭期间观看的视频不会进入历史, Time watched 统计不可用.',
  unreadable: '人工核对未能读取观看历史. 无法判断本场视频是否存在于记录中.',
  'not-found': '人工核对未找到本场视频的历史条目. 删除, 自动删除或关闭历史均可能影响结果, 不能据此断言未观看.',
  found: '人工核对找到了本场视频的历史条目. 条目仅表明历史中存在此视频, 不证明本场观看分钟或观看完成.',
}

export function buildYouTubeWatchEvidence(input: YouTubeWatchEvidenceInput): YouTubeWatchEvidenceState {
  const validVideoId = typeof input.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(input.videoId)
  let status: YouTubeHistoryStatus = 'unreadable'
  let source: 'youtube-watch-history-manual' | null = null
  let checkedAt: number | null = null
  let message = '需要在官方观看历史页面手工核对当前账号与本场视频. playlistItems API 不提供观看历史.'
  const evidence = input.manualEvidence

  if (input.authorized !== true || !input.accountRef?.trim()) {
    status = 'unauthorized'
    message = '缺少当前账号引用或核对授权. 播放取流登录不等于允许使用个人观看历史证据.'
  } else if (!validVideoId) {
    message = '缺少本场正式视频 ID. 频道 ID 不能代替视频 ID 核对个人观看历史.'
  } else if (evidence) {
    if (evidence.accountRef !== input.accountRef || evidence.videoId !== input.videoId) {
      message = '人工证据与当前账号或本场视频不匹配. 切换账号或场次后需要重新核对.'
    } else if (
      evidence.source !== 'youtube-watch-history-manual'
      || evidence.scope !== 'account-video'
      || !Object.hasOwn(HISTORY_MESSAGES, evidence.status)
      || !Number.isSafeInteger(evidence.checkedAt)
      || evidence.checkedAt <= 0
    ) {
      message = '人工证据缺少有效来源, 账号和视频范围, 状态或核对时间. 无法确认历史结果.'
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
      message: 'YouTube 移动端: 头像 > 时间管理 > Time watched. 显示个人今日, 昨日, 过去 7 天及日均总量, 基于观看历史, 不提供逐场分钟. 官方还提示电脑观看时长存在误报, 已删除及隐私窗口观看不计入.',
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
