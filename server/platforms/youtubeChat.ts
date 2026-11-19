import { setTimeout as sleep } from 'node:timers/promises'
import type { ResolvedStream } from './types'
import {
  YouTubeChatReplay, youtubeChannelId, youtubeOpaqueId, youtubeRecord, youtubeTimestamp, youtubeVideoId,
  type YouTubeChatEvent, type YouTubeChatIdentity, type YouTubeVideoTarget,
} from './youtubeChatEvents'

export type { YouTubeChatEvent, YouTubeChatIdentity, YouTubeChatMessage, YouTubeVideoTarget } from './youtubeChatEvents'

const API = 'https://www.googleapis.com/youtube/v3/'
const REQUEST_TIMEOUT_MS = 15_000
const FALLBACK_POLL_INTERVAL_MS = 10_000
const MAX_RETRIES = 4
const MAX_TIMER_MS = 2_147_483_647

export const YOUTUBE_CHAT_STATUS_TEXT = {
  connecting: '正在读取 YouTube 直播聊天.',
  connected: 'YouTube 直播聊天已连接.',
  reconnecting: 'YouTube 直播聊天正在重试.',
  'authorization-required': '需要当前账号单独授权 YouTube 聊天读取.',
  'credentials-unavailable': 'YouTube 聊天 API 凭据不可用.',
  'credentials-expired': 'YouTube 聊天授权已失效, 请重新授权.',
  'permission-denied': '当前授权无法读取该 YouTube 直播聊天.',
  'video-unavailable': 'YouTube 未返回当前直播视频, 或视频与已解析片源不符.',
  'chat-unavailable': 'YouTube 未返回当前场次可用的直播聊天.',
  'chat-disabled': '这场 YouTube 直播已禁用聊天.',
  ended: '这场 YouTube 直播聊天已结束.',
  'quota-exhausted': 'YouTube Data API 配额已用尽.',
  'rate-limited': 'YouTube 聊天 API 暂时限制请求频率.',
  'upstream-error': '暂时无法读取 YouTube 直播聊天.',
} as const

export type YouTubeChatStatusCode = keyof typeof YOUTUBE_CHAT_STATUS_TEXT
export type YouTubeChatStatus = {
  code: YouTubeChatStatusCode
  accountRef: string | null
  target: YouTubeVideoTarget
  identity?: YouTubeChatIdentity
  historyGapPossible: boolean
}

export const YOUTUBE_CHAT_WRITE_CAPABILITIES = {
  postMessage: 'unsupported',
  retractOwnMessage: 'unsupported',
  deleteMessage: 'unsupported',
  moderate: 'unsupported',
  vote: 'unsupported',
  subscribe: 'unsupported',
  joinMembership: 'unsupported',
  purchaseSuperChat: 'unsupported',
  purchaseSuperSticker: 'unsupported',
  giftMembership: 'unsupported',
  sendJewelsGift: 'unsupported',
} as const

export type YouTubeChatReadOptions = {
  target: YouTubeVideoTarget
  accountRef: string | null
  grant?: Readonly<{ accountRef: string; accessToken: string }> | null
  signal: AbortSignal
  onStatus: (status: YouTubeChatStatus) => void
  onEvent: (event: YouTubeChatEvent) => void
  hl?: string
  fetch?: (url: URL, init: RequestInit) => Promise<Response>
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

export function youtubeVideoTarget(stream: Pick<ResolvedStream, 'platform' | 'channel' | 'sourceRoom'> | null): YouTubeVideoTarget | null {
  if (stream?.platform !== 'youtube') return null
  const videoId = youtubeVideoId(stream.channel)
  return videoId ? { videoId, channelId: youtubeChannelId(stream.sourceRoom) } : null
}

type RetryableCode = 'rate-limited' | 'upstream-error'
type RequestFailure = {
  failure: YouTubeChatStatusCode
  retry?: RetryableCode
  retryAfterMs?: number
  invalidCursor?: boolean
}
type ApiResult = { value: Record<string, unknown> } | RequestFailure

function retryAfterMs(raw: string | null, now: number): number | undefined {
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const time = Date.parse(raw)
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined
}

function classify(response: Response, value: Record<string, unknown>, now: number): RequestFailure {
  const error = youtubeRecord(value.error)
  const reasons = new Set<string>()
  for (const field of [error.errors, error.details]) {
    if (!Array.isArray(field)) continue
    for (const item of field) {
      const reason = youtubeRecord(item).reason
      if (typeof reason === 'string') reasons.add(reason)
    }
  }
  if (reasons.has('liveChatDisabled')) return { failure: 'chat-disabled' }
  if (reasons.has('liveChatEnded')) return { failure: 'ended' }
  if (reasons.has('liveChatNotFound')) return { failure: 'chat-unavailable' }
  if (reasons.has('invalidPageToken')) return { failure: 'upstream-error', invalidCursor: true }
  if (reasons.has('quotaExceeded') || reasons.has('dailyLimitExceeded') || reasons.has('QUOTA_EXCEEDED')) return { failure: 'quota-exhausted' }
  if (reasons.has('accessNotConfigured') || reasons.has('SERVICE_DISABLED') || reasons.has('PROJECT_DENIED')) return { failure: 'credentials-unavailable' }
  if (response.status === 401) return { failure: 'credentials-expired' }
  const retryAfter = retryAfterMs(response.headers.get('retry-after'), now)
  if (response.status === 429 || reasons.has('rateLimitExceeded') || reasons.has('userRateLimitExceeded')) {
    return { failure: 'rate-limited', retry: 'rate-limited', retryAfterMs: retryAfter }
  }
  if (response.status >= 500 || response.status === 408) {
    return { failure: 'upstream-error', retry: 'upstream-error', retryAfterMs: retryAfter }
  }
  if (response.status === 403) return { failure: 'permission-denied' }
  if (response.status === 404) return { failure: 'chat-unavailable' }
  return { failure: 'upstream-error' }
}

type LiveVideoChat = { identity: YouTubeChatIdentity; broadcastStartedAt?: number }

function videoChat(value: Record<string, unknown>, target: YouTubeVideoTarget): LiveVideoChat | RequestFailure {
  if (!Array.isArray(value.items)) return { failure: 'upstream-error' }
  const item = value.items.map(youtubeRecord).find(item => item.id === target.videoId)
  const channelId = youtubeChannelId(youtubeRecord(item?.snippet).channelId)
  if (!item || !channelId || (target.channelId && channelId !== target.channelId)) return { failure: 'video-unavailable' }
  const details = youtubeRecord(item.liveStreamingDetails)
  if (youtubeTimestamp(details.actualEndTime) !== undefined) return { failure: 'ended' }
  const liveChatId = youtubeOpaqueId(details.activeLiveChatId)
  return liveChatId ? {
    identity: { videoId: target.videoId, channelId, liveChatId },
    broadcastStartedAt: youtubeTimestamp(details.actualStartTime),
  } : { failure: 'chat-unavailable' }
}

function pollInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1000, Math.ceil(value))
    : FALLBACK_POLL_INTERVAL_MS
}

export async function readYouTubeLiveChat(options: YouTubeChatReadOptions): Promise<void> {
  const { accountRef, signal, grant, onStatus, onEvent } = options
  const target = { ...options.target }
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }))
  const fetcher = options.fetch ?? fetch
  let video: LiveVideoChat | undefined
  let historyGapPossible = false
  let status: YouTubeChatStatus | undefined
  const publish = (code: YouTubeChatStatusCode) => {
    if (!signal.aborted && (code !== status?.code || historyGapPossible !== status.historyGapPossible)) {
      status = { code, accountRef, target, identity: video?.identity, historyGapPossible }
      onStatus(status)
    }
  }
  if (signal.aborted) return
  if (!youtubeVideoId(target.videoId) || (target.channelId !== undefined && !youtubeChannelId(target.channelId))) {
    return publish('video-unavailable')
  }
  if (grant === undefined) return publish('credentials-unavailable')
  if (!accountRef || !grant || grant.accountRef !== accountRef) return publish('authorization-required')
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(grant.accessToken)) return publish('credentials-unavailable')
  const accessToken = grant.accessToken

  async function request(route: 'videos' | 'liveChat/messages', query: Record<string, string>): Promise<ApiResult> {
    const url = new URL(route, API)
    url.search = new URLSearchParams(query).toString()
    try {
      const response = await fetcher(url, {
        method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      })
      if (!response.ok) return classify(response, youtubeRecord(await response.json().catch(() => undefined)), now())
      return { value: youtubeRecord(await response.json()) }
    } catch {
      return { failure: 'upstream-error', retry: 'upstream-error' }
    }
  }

  async function pause(ms: number): Promise<boolean> {
    if (signal.aborted) return false
    try { await wait(ms, signal) }
    catch (error) { if (!signal.aborted) throw error }
    return !signal.aborted
  }

  let retries = 0
  async function retry(result: RequestFailure, minimumDelay = 0): Promise<boolean> {
    const delay = Math.max(minimumDelay, result.retryAfterMs ?? 0, 2_000 * 2 ** retries)
    if (!result.retry || retries >= MAX_RETRIES || delay > MAX_TIMER_MS) {
      publish(result.failure)
      return false
    }
    retries++
    publish('reconnecting')
    return pause(delay)
  }

  async function resolveVideo(): Promise<LiveVideoChat | RequestFailure> {
    const result = await request('videos', {
      part: 'snippet,liveStreamingDetails', id: target.videoId,
      fields: 'items(id,snippet/channelId,liveStreamingDetails(activeLiveChatId,actualStartTime,actualEndTime))',
    })
    return 'failure' in result ? result : videoChat(result.value, target)
  }

  publish('connecting')
  while (!signal.aborted && !video) {
    const resolved = await resolveVideo()
    if (signal.aborted) return
    if ('failure' in resolved) {
      if (!await retry(resolved)) return
    } else {
      video = resolved
    }
  }
  if (!video || signal.aborted) return

  const replay = new YouTubeChatReplay(video.identity, video.broadcastStartedAt)
  const language = options.hl && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(options.hl) ? options.hl : 'zh-CN'
  let cursor: string | undefined
  let interval = FALLBACK_POLL_INTERVAL_MS
  retries = 0
  while (!signal.aborted) {
    const result = await request('liveChat/messages', {
      part: 'id,snippet,authorDetails', liveChatId: video.identity.liveChatId, hl: language,
      ...(cursor ? { pageToken: cursor } : {}),
    })
    if (signal.aborted) return
    if ('failure' in result) {
      if (result.invalidCursor && cursor && !historyGapPossible) {
        cursor = undefined
        historyGapPossible = true
        publish('reconnecting')
        if (!await pause(interval)) return
      } else if (!await retry(result, interval)) {
        return
      }
      continue
    }
    const receivedAt = now()
    const next = youtubeOpaqueId(result.value.nextPageToken)
    interval = pollInterval(result.value.pollingIntervalMillis)
    if ((Array.isArray(result.value.items) && result.value.items.length) || result.value.activePollItem) {
      const current = await resolveVideo()
      if (signal.aborted) return
      if ('failure' in current) {
        if (!await retry(current, interval)) return
        continue
      }
      if (current.identity.liveChatId !== video.identity.liveChatId
        || current.identity.channelId !== video.identity.channelId
        || current.broadcastStartedAt !== video.broadcastStartedAt) {
        return publish('chat-unavailable')
      }
    }
    const events = replay.applyPage(result.value, receivedAt)
    if (next || events.length) publish('connected')
    for (const event of events) {
      if (signal.aborted) return
      onEvent(event)
      if (event.type === 'ended') return publish('ended')
    }
    if (!next) {
      if (!await retry({ failure: 'upstream-error', retry: 'upstream-error' }, interval)) return
      continue
    }
    cursor = next
    retries = 0
    if (interval > MAX_TIMER_MS) return publish('rate-limited')
    if (!await pause(interval)) return
  }
}
