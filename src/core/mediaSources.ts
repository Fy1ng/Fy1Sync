/**
 * Turn whatever the user pasted into a `MediaDescriptor`.
 *
 * Channel pages (twitch.tv/xxx, douyu.com/123) cannot be played directly; they
 * are marked `needsResolve` so the caller asks main for a registered playable URL.
 * Anything else that is a plain web page is rejected with an explanation rather
 * than handed to `<video>`, which would just fail silently.
 */

import type { MediaDescriptor, MediaKind, PlatformId } from './types'

export interface SourceClassification {
  ok: true
  platform: PlatformId
  kind: MediaKind
  /** Normalised URL to play, or the channel URL when `needsResolve`. */
  url: string
  /** Channel/room identifier for platform resolution. */
  channel?: string
  needsResolve: boolean
  /** Legacy metadata: cross-origin media needs main-process registration. */
  suggestProxy: boolean
  label: string
}

export interface SourceRejection {
  ok: false
  reason: 'empty' | 'not-a-url' | 'unsupported-scheme' | 'unsupported-page'
  message: string
}

export type SourceParseResult = SourceClassification | SourceRejection

const HLS_PATTERN = /\.m3u8(\?|$)/iu
const DASH_PATTERN = /\.mpd(\?|$)/iu
const PROGRESSIVE_PATTERN = /\.(mp4|m4v|webm|ogv|mov|mkv|flv|ts)(\?|$)/iu

export function parseSourceInput(raw: string): SourceParseResult {
  const input = raw.trim()
  if (!input) return { ok: false, reason: 'empty', message: '请输入直播间地址或媒体链接' }

  if (/^[1-9][0-9]{0,11}$/.test(input)) return {
    ok: true, platform: 'douyu', kind: 'hls', url: input, channel: input,
    needsResolve: true, suggestProxy: true, label: `斗鱼 / ${input}`,
  }

  // Bare test fixtures and same-origin paths.
  if (input.startsWith('/')) {
    return {
      ok: true,
      platform: input.startsWith('/test-sources/') ? 'test' : 'direct',
      kind: HLS_PATTERN.test(input) ? 'hls' : 'progressive',
      url: input,
      needsResolve: false,
      suggestProxy: false,
      label: input.split('/').pop() ?? input,
    }
  }

  // blob:/data: carry no `//` after the scheme, so they must be handled before
  // the "add a missing scheme" normalisation below.
  if (/^(blob|data):/iu.test(input)) {
    return {
      ok: true,
      platform: 'file',
      kind: 'file',
      url: input,
      needsResolve: false,
      suggestProxy: false,
      label: '本地文件',
    }
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: 'not-a-url', message: '无法解析这个地址，请检查是否输入完整' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'unsupported-scheme',
      message: `不支持 ${url.protocol} 协议，请使用 http(s) 链接或本地文件`,
    }
  }

  const host = url.hostname.toLowerCase().replace(/^www\./u, '').replace(/^m\./u, '')

  if (host === 'youtube.com' || host === 'youtu.be') {
    return { ok: true, platform: 'youtube', kind: 'hls', url: url.href,
      needsResolve: true, suggestProxy: false, label: 'YouTube 直播' }
  }

  if (host === 'live.bilibili.com') {
    const room = firstPathSegment(url)
    if (!room || !/^\d+$/.test(room)) return { ok: false, reason: 'unsupported-page', message: 'B 站链接里没有房间号' }
    return { ok: true, platform: 'bilibili', kind: 'hls', url: `https://live.bilibili.com/${room}`,
      needsResolve: true, suggestProxy: false, label: `B 站 / ${room}`, channel: room }
  }

  if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
    const channel = firstPathSegment(url)
    if (!channel) {
      return { ok: false, reason: 'unsupported-page', message: 'Twitch 链接里没有频道名' }
    }
    return {
      ok: true,
      platform: 'twitch',
      kind: 'hls',
      url: `https://www.twitch.tv/${channel}`,
      channel,
      needsResolve: true,
      suggestProxy: true,
      label: `Twitch / ${channel}`,
    }
  }

  if (host === 'douyu.com' || host.endsWith('.douyu.com')) {
    const room = url.searchParams.get('rid') ?? firstPathSegment(url)
    if (!room) {
      return { ok: false, reason: 'unsupported-page', message: '斗鱼链接里没有房间号' }
    }
    return {
      ok: true,
      platform: 'douyu',
      kind: 'hls',
      url: url.href,
      channel: room,
      needsResolve: true,
      suggestProxy: true,
      label: `斗鱼 / ${room}`,
    }
  }

  const path = url.pathname
  if (HLS_PATTERN.test(path)) {
    return directMedia(url, 'hls')
  }
  if (PROGRESSIVE_PATTERN.test(path)) {
    return directMedia(url, 'progressive')
  }
  if (DASH_PATTERN.test(path)) {
    return {
      ok: false,
      reason: 'unsupported-page',
      message: '暂不支持 DASH（.mpd），请提供 HLS 或 MP4 地址',
    }
  }

  return {
    ok: false,
    reason: 'unsupported-page',
    message: '请填入 YouTube / Twitch / 斗鱼 / B 站直播间地址, 或直接的 .m3u8 / .mp4 / .flv 链接',
  }
}

function directMedia(url: URL, kind: MediaKind): SourceClassification {
  return {
    ok: true,
    platform: 'direct',
    kind,
    url: url.href,
    needsResolve: true,
    suggestProxy: isCrossOrigin(url),
    label: url.hostname,
  }
}

function firstPathSegment(url: URL): string | null {
  const segment = url.pathname.split('/').filter(Boolean)[0]
  if (!segment) return null
  return /^[A-Za-z0-9_-]+$/u.test(segment) ? segment : null
}

function isCrossOrigin(url: URL): boolean {
  if (typeof location === 'undefined') return true
  return url.origin !== location.origin
}

export function describeSource(descriptor: MediaDescriptor | null): string {
  if (!descriptor) return '未设置'
  return descriptor.label || descriptor.url
}

/** Build the descriptor handed to the player. */
export function toDescriptor(
  classification: SourceClassification,
  options: { url?: string; viaProxy?: boolean; loop?: boolean } = {},
): MediaDescriptor {
  const resolved = options.url ?? classification.url
  const viaProxy = options.viaProxy ?? false
  return {
    kind: classification.kind,
    url: resolved,
    input: classification.url,
    label: classification.label,
    loop: options.loop ?? false,
    viaProxy,
    platform: classification.platform,
  }
}
