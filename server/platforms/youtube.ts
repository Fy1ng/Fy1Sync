/** YouTube live metadata is acquired by the main process's isolated yt-dlp runner. */

import { failure, MANUAL_URL_HINT, type QualityOption, type ResolvedStream, type ResolveResult, type ResolverDeps } from './types'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com'])
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/

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

/** Expose only higher-than-HLS renditions, one codec per height/fps with VP9 preferred. */
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
  if (!requested || requested === 'auto') return preferAdaptive ? formats[0] : formats.find(item => !item.adaptive)
  const exact = formats.find((item) => item.format_id === requested)
  if (exact) return exact
  const size = requested.match(/^(\d{2,4})p(?:(\d{1,3}(?:\.\d+)?))?$/i)
  if (!size) return undefined
  const height = Number(size[1])
  const fps = size[2] ? Number(size[2]) : Infinity
  return formats.find((item) => item.height <= height && item.fps <= fps)
}

export async function resolveYouTube(input: string, deps: ResolverDeps): Promise<ResolveResult> {
  const url = parseYouTubeUrl(input)
  if (!url) return failure('unsupported-url', '请输入有效的 YouTube 直播视频或频道地址.', MANUAL_URL_HINT)
  if (!deps.runYtDlp) return failure('upstream-error', 'YouTube 解析工具尚未配置.', '请配置 yt-dlp 和 Electron Node 运行时后重试.')
  let info: unknown
  try { info = await deps.runYtDlp(url) }
  catch (error) {
    // Extractor errors can contain cookies, headers or signed URLs. Classify but never echo them.
    const message = error instanceof Error ? error.message : ''
    if (/not a bot|sign.?in|private video|members.only|age.restricted|geo.restricted|not available in your country/i.test(message)) {
      return failure('restricted', 'YouTube 要求登录, 或此直播受到访问限制.', '请在账号区域登录 YouTube 后重试.')
    }
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
  if (!hlsFormats.length) return failure('needs-manual-url', 'YouTube 未返回可转封装的 H.264/AAC HLS 直播流.', MANUAL_URL_HINT)
  const formats = [...hlsFormats, ...youtubeAdaptiveFormats(info, hlsFormats[0]!.height)]
    .sort((a, b) => b.height - a.height || b.fps - a.fps || b.tbr - a.tbr)
  const selected = selectYouTubeFormat(formats, deps.quality, deps.preferAdaptive)
  if (!selected) return failure('unsupported-url', '当前 YouTube 直播不提供所选画质.', '请重新解析并选择列表中的画质.')
  const qualities: QualityOption[] = formats.map((item) => ({ id: item.format_id, label: `${item.height}p${item.fps > 30 ? item.fps : ''}`, height: item.height, ...(item.fps ? { fps: item.fps } : {}), ...(item.adaptive ? { adaptive: true } : {}) }))
  // Titles and authenticated http_headers are deliberately excluded from IPC metadata.
  return { ok: true, stream: {
    platform: 'youtube', url: deps.proxify(selected.adaptive ? hlsFormats[0]!.url : selected.url), kind: 'hls', label: 'YouTube 直播',
    channel: typeof data.id === 'string' && VIDEO_ID.test(data.id) ? data.id : url,
    requiresProxy: true, qualities, quality: selected.format_id,
    ...(selected.adaptive ? { adaptive: selected.adaptive } : {}),
    notes: ['直播地址会过期, 断流后将重新解析并恢复本地缓冲.'],
  } }
}
