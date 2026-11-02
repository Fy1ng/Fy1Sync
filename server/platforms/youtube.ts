import { StreamFailureError } from '../networkFailure'
/** YouTube live metadata is acquired by the main process's isolated yt-dlp runner. */

import { failure, MANUAL_URL_HINT, type QualityOption, type ResolvedStream, type ResolveResult, type ResolverDeps } from './types'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/
/** First path segments that are YouTube's own pages, never an old-style channel name. */
const RESERVED_PATHS = new Set(['watch', 'live', 'embed', 'shorts', 'playlist', 'results', 'search', 'feed', 'feeds',
  'channel', 'user', 'hashtag', 'gaming', 'premium', 'music', 'kids', 'about', 'account', 'signin', 'logout', 'upload',
  'redirect', 'attribution_link', 'oembed', 'iframe_api', 'get_video_info', 'clip', 'post', 'source', 'trending',
  'explore', 'movies', 'browse', 'storefront', 'shared', 'api', 'youtubei', 'error', 'signup', 'channels', 'red',
  'watch_popup', 'live_chat', 'studio', 'video', 'videos', 'community', 'podcasts', 'news', 'courses', 'new'])

/** Canonicalize public watch/channel pages and never pass arbitrary extractor URLs. */
export function parseYouTubeUrl(input: string): string | null {
  let url: URL
  try { url = new URL(input.trim().startsWith('http') ? input.trim() : `https://${input.trim()}`) }
  catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
  const host = url.hostname.toLowerCase()
  const path = url.pathname.replace(/\/+$/, '')
  if (SHORT_HOSTS.has(host)) {
    const id = path.slice(1)
    return VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
  }
  if (!YOUTUBE_HOSTS.has(host)) return null
  const id = path === '/watch' ? url.searchParams.get('v') : path.match(/^\/live\/([a-zA-Z0-9_-]{11})$/)?.[1]
  if (id && VIDEO_ID.test(id)) return `https://www.youtube.com/watch?v=${id}`
  if (/^\/@[^/?#\s]{1,100}(?:\/live)?$/.test(path) || /^\/(?:channel|c|user)\/[a-zA-Z0-9_-]{1,100}(?:\/live)?$/.test(path)) {
    return `https://www.youtube.com${path.endsWith('/live') ? path : `${path}/live`}`
  }
  // An old-style channel name straight after the host (youtube.com/PGL), as event pages still link it.
  const legacy = /^\/([a-zA-Z0-9_-]{3,100})(?:\/live)?$/.exec(path)?.[1]
  if (legacy && !RESERVED_PATHS.has(legacy.toLowerCase())) return `https://www.youtube.com/${legacy}/live`
  return null
}

export type YouTubeFormat = {
  format_id: string
  url: string
  protocol: string
  height: number
  fps: number
  tbr: number
  vcodec: string
  acodec: string
  adaptive?: ResolvedStream['adaptive']
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** P2 uses muxed H.264/AAC HLS so one copy-only ffmpeg input retains both tracks. */
export function youtubeFormats(info: unknown): YouTubeFormat[] {
  const formats = record(info).formats
  if (!Array.isArray(formats)) return []
  const seen = new Set<string>()
  return formats.flatMap((raw): YouTubeFormat[] => {
    const item = record(raw)
    if (typeof item.format_id !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(item.format_id) || seen.has(item.format_id)) return []
    if (typeof item.protocol !== 'string' || !/^m3u8(?:_native)?$/.test(item.protocol)) return []
    if (typeof item.vcodec !== 'string' || !/^(?:avc1|h264)/i.test(item.vcodec)) return []
    if (typeof item.acodec !== 'string' || !/^(?:mp4a|aac)/i.test(item.acodec)) return []
    if (typeof item.url !== 'string' || !number(item.height)) return []
    try {
      const url = new URL(item.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return []
    } catch { return [] }
    seen.add(item.format_id)
    return [{ format_id: item.format_id, url: item.url, protocol: item.protocol, height: number(item.height), fps: number(item.fps), tbr: number(item.tbr), vcodec: item.vcodec, acodec: item.acodec }]
  }).sort((a, b) => b.height - a.height || b.fps - a.fps || b.tbr - a.tbr)
}

/** Signed adaptive inputs stay private and are accepted only from YouTube's media hosts. */
function adaptiveUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /^(?:[a-z0-9-]+\.)+googlevideo\.com$/i.test(url.hostname)
      && url.pathname === '/videoplayback'
  } catch { return false }
}

/** Expose higher-than-HLS renditions, or all supported pairs when HLS is absent. */
export function youtubeAdaptiveFormats(info: unknown, bestHlsHeight: number): YouTubeFormat[] {
  const source = record(info).formats
  if (!Array.isArray(source)) return []
  const formats = source.map(record).filter(item => typeof item.format_id === 'string'
    && /^[a-zA-Z0-9_.-]{1,100}$/.test(item.format_id) && adaptiveUrl(item.url)
    && (item.protocol === 'https' || item.protocol === 'http_dash_segments'))
  const audio = formats.filter(item => (item.vcodec === 'none' || item.vcodec == null)
    && typeof item.acodec === 'string' && /^(?:mp4a|aac)/i.test(item.acodec)
    && (item.ext === 'm4a' || item.ext === 'mp4'))
    .sort((a, b) => Number(b.format_id === '140') - Number(a.format_id === '140') || number(b.tbr) - number(a.tbr))[0]
  if (!audio || !adaptiveUrl(audio.url)) return []
  const candidates = formats.filter(item => number(item.height) > bestHlsHeight && item.acodec === 'none'
    && typeof item.vcodec === 'string' && ((/^vp0?9(?:\.|$)/i.test(item.vcodec) && item.ext === 'webm')
      || (/^av01(?:\.|$)/i.test(item.vcodec) && item.ext === 'mp4')))
    .sort((a, b) => number(b.height) - number(a.height) || number(b.fps) - number(a.fps)
      || Number(/^vp0?9/i.test(String(b.vcodec))) - Number(/^vp0?9/i.test(String(a.vcodec))) || number(b.tbr) - number(a.tbr))
  const seen = new Set<string>()
  return candidates.flatMap(item => {
    const key = `${number(item.height)}:${number(item.fps)}`
    if (seen.has(key) || !adaptiveUrl(item.url)) return []
    seen.add(key)
    return [{ format_id: item.format_id as string, url: item.url, protocol: item.protocol as string,
      height: number(item.height), fps: number(item.fps), tbr: number(item.tbr), vcodec: item.vcodec as string, acodec: 'none',
      adaptive: { videoUrl: item.url, audioUrl: audio.url as string, videoContainer: item.ext as 'webm' | 'mp4', height: number(item.height) } }]
  })
}

/** A quality can be the exposed format id, or a requested height/fps such as 720p60. */
export function selectYouTubeFormat(formats: YouTubeFormat[], requested?: string, preferAdaptive = false): YouTubeFormat | undefined {
  if (!requested || requested === 'auto') return preferAdaptive ? formats[0]
    : formats.find(item => !item.adaptive) ?? formats.find(item => item.height <= 1080) ?? formats[0]
  const exact = formats.find((item) => item.format_id === requested)
  if (exact) return exact
  const size = requested.match(/^(\d{2,4})p(?:(\d{1,3}(?:\.\d+)?))?$/i)
  if (!size) return undefined
  const height = Number(size[1])
  const fps = size[2] ? Number(size[2]) : Infinity
  return formats.find((item) => item.height <= height && item.fps <= fps)
}

/** Why YouTube refused a stream, as fixed categories. Extractor text never reaches the UI. */
export type YouTubeRefusal = 'bot-check' | 'sign-in' | 'members-only' | 'age-restricted' | 'geo-restricted' | 'private'

/** Wording per refusal, shown as is. src/studio/sources.tsx decides which ones a sign-in can lift. */
export const YOUTUBE_REFUSALS: Record<YouTubeRefusal, { message: string; hint?: string }> = {
  'bot-check': { message: 'YouTube 要求验证不是机器人, 当前网络暂时不能观看.', hint: '换一个代理节点, 或稍后重试.' },
  'sign-in': { message: 'YouTube 要求登录后才能观看此直播.' },
  'members-only': { message: '此直播仅限频道会员观看.', hint: '需要有该频道会员资格的 YouTube 账号.' },
  'age-restricted': { message: '此直播有年龄限制.', hint: '需要已确认年龄的 YouTube 账号.' },
  'geo-restricted': { message: '此直播在当前网络所在的地区不可观看.', hint: '换一个所在地区不同的代理节点后重试.' },
  private: { message: '此直播未公开, 无法观看.' },
}

export function isYouTubeRefusal(value: unknown): value is YouTubeRefusal {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(YOUTUBE_REFUSALS, value)
}

/** Fixed format failures survive sanitization without exposing extractor output. */
export const YOUTUBE_FORMAT_FAILURES = {
  'youtube-formats-empty': {
    message: 'YouTube 没有返回直播音视频格式.',
    hint: '请重新解析. 若仍失败, 请反馈错误代码 YT-FORMATS-EMPTY 以及应用和 yt-dlp 版本.',
  },
  'youtube-hls-separated': {
    message: 'YouTube 本次返回了分离的直播音视频轨, 暂无法播放.',
    hint: '请重新解析. 若仍失败, 请反馈错误代码 YT-HLS-SEPARATED 以及应用和 yt-dlp 版本.',
  },
  'youtube-hls-unsupported': {
    message: 'YouTube 返回的直播格式不符合播放要求.',
    hint: '请反馈错误代码 YT-HLS-UNSUPPORTED 以及应用和 yt-dlp 版本.',
  },
  'youtube-hls-missing': {
    message: 'YouTube 已返回直播信息, 但没有适用于当前播放器的音视频流.',
    hint: '请重新解析. 若仍失败, 请反馈错误代码 YT-HLS-MISSING 以及应用和 yt-dlp 版本.',
  },
} as const
export type YouTubeFormatFailure = keyof typeof YOUTUBE_FORMAT_FAILURES

export function isYouTubeFormatFailure(value: unknown): value is YouTubeFormatFailure {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(YOUTUBE_FORMAT_FAILURES, value)
}

function formatFailure(info: unknown): Extract<ResolveResult, { ok: false }> {
  const raw = record(info).formats
  const formats = Array.isArray(raw) ? raw.map(record) : []
  const hls = formats.filter(item => typeof item.protocol === 'string' && /^m3u8(?:_native)?$/.test(item.protocol))
  const reason: YouTubeFormatFailure = !formats.length ? 'youtube-formats-empty'
    : hls.some(item => item.acodec === 'none' || item.vcodec === 'none') ? 'youtube-hls-separated'
      : hls.length ? 'youtube-hls-unsupported' : 'youtube-hls-missing'
  return { ok: false, failure: { code: 'needs-manual-url', reason, ...YOUTUBE_FORMAT_FAILURES[reason] } }
}

/** Order matters: "Sign in to confirm you're not a bot" and "...confirm your age" are sign-in messages too. */
function refusalFor(message: string): YouTubeRefusal | undefined {
  if (/age.restricted|confirm your age/i.test(message)) return 'age-restricted'
  if (/not a bot|bot check/i.test(message)) return 'bot-check'
  if (/members.only/i.test(message)) return 'members-only'
  if (/geo.restricted|available in your country|available from your location/i.test(message)) return 'geo-restricted'
  if (/private video/i.test(message)) return 'private'
  if (/sign.?in|login/i.test(message)) return 'sign-in'
  return undefined
}

export async function resolveYouTube(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const url = parseYouTubeUrl(input)
  if (!url) return failure('unsupported-url', '请输入有效的 YouTube 直播视频或频道地址.', MANUAL_URL_HINT)
  if (!deps.runYtDlp) return failure('upstream-error', 'YouTube 解析工具尚未配置.', '请配置 yt-dlp 和 Electron Node 运行时后重试.')
  let info: unknown
  try { info = await deps.runYtDlp(url) }
  catch (error) {
    if (error instanceof StreamFailureError) throw error
    // Extractor errors can contain cookies, headers or signed URLs. Classify but never echo them.
    const message = error instanceof Error ? error.message : ''
    const refusal = refusalFor(message)
    if (refusal) return { ok: false, failure: { code: 'restricted', reason: refusal, ...YOUTUBE_REFUSALS[refusal] } }
    if (/not (?:currently )?live|recording is not available|live (?:event|stream) (?:has ended|will begin)|not broadcasting/i.test(message)) {
      return failure('not-live', '该 YouTube 频道当前未开播.', MANUAL_URL_HINT)
    }
    return failure('upstream-error', 'YouTube 直播解析失败.', '请检查网络, 登录状态和 yt-dlp 配置后重试.')
  }
  const data = record(info)
  if (data.is_live !== true || (typeof data.live_status === 'string' && data.live_status !== 'is_live')) {
    return failure('not-live', '该 YouTube 视频当前不是直播, 暂不支持点播或直播回放.', MANUAL_URL_HINT)
  }
  const hlsFormats = youtubeFormats(info)
  const adaptiveFormats = deps.hlsOnly ? [] : youtubeAdaptiveFormats(info, hlsFormats[0]?.height ?? 0)
  if (!hlsFormats.length && !adaptiveFormats.length) return formatFailure(info)
  const formats = [...hlsFormats, ...adaptiveFormats]
    .sort((a, b) => b.height - a.height || b.fps - a.fps || b.tbr - a.tbr)
  const selected = selectYouTubeFormat(formats, deps.quality, deps.preferAdaptive)
  if (!selected) return failure('unsupported-url', '当前 YouTube 直播不提供所选画质.', '请重新解析并选择列表中的画质.')
  const qualities: QualityOption[] = formats.map((item) => ({ id: item.format_id, label: `${item.height}p${item.fps > 30 ? item.fps : ''}`, height: item.height, ...(item.fps ? { fps: item.fps } : {}), ...(item.adaptive ? { adaptive: true } : {}) }))
  // Titles and authenticated http_headers are deliberately excluded from IPC metadata.
  return { ok: true, stream: {
    platform: 'youtube', url: deps.proxify(selected.adaptive ? hlsFormats[0]?.url ?? selected.url : selected.url), kind: 'hls', label: 'YouTube 直播',
    channel: typeof data.id === 'string' && VIDEO_ID.test(data.id) ? data.id : url,
    requiresProxy: true, qualities, quality: selected.format_id,
    ...(selected.adaptive ? { adaptive: selected.adaptive } : {}),
    notes: ['直播地址会过期, 断流后将重新解析并恢复本地缓冲.'],
  } }
}
