/** Platform dispatch: pick a resolver from the user's input, or treat it as direct media. */

import { resolveBilibili, parseBilibiliRoom } from './bilibili'
import { resolveDouyu, parseDouyuRoom } from './douyu'
import { resolveTwitch, parseTwitchChannel } from './twitch'
import { resolveYouTube, parseYouTubeUrl } from './youtube'
import { failure, type PlatformKind, type ResolveResult, type ResolverDeps } from './types'

export type { PlatformKind, QualityOption, ResolveResult, ResolvedStream, ResolverDeps } from './types'
export { parseBilibiliRoom, parseDouyuRoom, parseTwitchChannel, parseYouTubeUrl }

const MEDIA_EXTENSIONS = ['.m3u8', '.m3u', '.mp4', '.flv', '.webm', '.mov', '.mkv', '.ts']

/** Which resolver an input belongs to. `explicit` lets the UI override the guess. */
export function detectPlatform(input: string, explicit?: PlatformKind): PlatformKind | null {
  if (explicit) return explicit
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  if (looksLikeDirectMedia(trimmed)) return 'direct'

  let host = ''
  try {
    host = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname.toLowerCase()
  } catch {
    return null
  }
  if (/(^|\.)twitch\.tv$/.test(host)) return 'twitch'
  if (/(^|\.)douyu\.com$/.test(host)) return 'douyu'
  if (/(^|\.)bilibili\.com$/.test(host)) return 'bilibili'
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'].includes(host)) return 'youtube'
  return looksLikeDirectMedia(trimmed) ? 'direct' : null
}

export function looksLikeDirectMedia(input: string): boolean {
  const trimmed = input.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  let path: string
  try {
    path = new URL(trimmed).pathname.toLowerCase()
  } catch {
    return false
  }
  return MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension))
}

export async function resolveStream(
  input: string,
  deps: ResolverDeps,
  explicit?: PlatformKind,
): Promise<ResolveResult> {
  const platform = detectPlatform(input, explicit)
  switch (platform) {
    case 'youtube':
      return resolveYouTube(input, deps)
    case 'twitch':
      return resolveTwitch(input, deps)
    case 'douyu':
      return resolveDouyu(input, deps)
    case 'bilibili':
      return resolveBilibili(input, deps)
    case 'direct':
      return resolveDirect(input)
    default:
      return failure(
        'unsupported-url',
        '无法识别该输入属于哪个平台',
        '支持 YouTube 直播, Twitch 频道, 斗鱼房间, B 站直播间, 或直接粘贴 m3u8 / mp4 / flv 地址.',
      )
  }
}

/**
 * A pasted media URL. Kept unproxied by default: many direct URLs are already
 * CORS-friendly, and going through the proxy needlessly would put this server in the
 * data path. The client retries via the proxy when a direct load fails or the canvas
 * ends up tainted.
 */
function resolveDirect(input: string): ResolveResult {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return failure('unsupported-url', '不是合法的媒体地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failure('unsupported-url', `仅支持 http/https 地址，收到 ${url.protocol}`)
  }
  const path = url.pathname.toLowerCase()
  const isHls = path.endsWith('.m3u8') || path.endsWith('.m3u')
  return {
    ok: true,
    stream: {
      platform: 'direct',
      url: url.toString(),
      kind: isHls ? 'hls' : 'progressive',
      label: url.hostname,
      channel: url.hostname,
      requiresProxy: false,
      notes: [
        '直接加载。若因跨域失败或无法识别倒计时，可在源设置中改为经本地代理加载。',
      ],
    },
  }
}
