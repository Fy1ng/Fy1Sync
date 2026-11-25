import { parseDouyinInput } from './douyinInput'
import type { MediaDescriptor } from './types'

export type RoomPlatform = 'douyu' | 'bilibili' | 'huya' | 'douyin'

export function parseRoomInput(text: string): { room: string; platform: RoomPlatform | null } | null {
  const value = text.trim()
  if (/^[1-9]\d{0,19}$/.test(value)) return { room: value, platform: null }
  const douyin = /^(?:douyin\s*[:：]?\s*|抖音\s*[:：]?\s*)([1-9]\d{0,19})$/i.exec(value)
  if (douyin) return { room: douyin[1]!, platform: 'douyin' }
  const huya = /^(?:(?:hy|huya)(?:\s*[:：]\s*|\s+)|虎牙\s*[:：]?\s*)([A-Za-z0-9_-]{1,64})$/i.exec(value)
  if (huya) return { room: huya[1]!, platform: 'huya' }
  const prefixed = /^(dy|douyu|斗鱼|b|bili|bilibili|b站|哔哩哔哩)\s*[:：]?\s*([1-9]\d{0,11})$/i.exec(value)
  if (!prefixed) return /^(?=.*[A-Za-z_-])[A-Za-z0-9_-]{1,64}$/.test(value) ? { room: value, platform: null } : null
  return { room: prefixed[2]!, platform: /^(dy|douyu|斗鱼)$/i.test(prefixed[1]!) ? 'douyu' : 'bilibili' }
}

export function roomFromInput(input: string | undefined): string | null {
  if (!input) return null
  const typed = parseRoomInput(input)
  if (typed) return typed.room
  const douyin = parseDouyinInput(input)
  if (douyin) return douyin.kind === 'room' ? douyin.room : null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    if (/(^|\.)douyin\.com$|(^|\.)amemv\.com$/i.test(url.hostname)) return null
    const rid = url.searchParams.get('rid')
    if (rid && /^\d{1,12}$/.test(rid)) return rid
    const segments = url.pathname.split('/').filter(Boolean).reverse()
    const numeric = segments.find((part) => /^\d{1,12}$/.test(part))
    if (numeric) return numeric
    if (/(^|\.)douyu\.com$/i.test(url.hostname)) return segments.find((part) => /^[A-Za-z0-9_]{1,32}$/.test(part)) ?? null
    if (/(^|\.)huya\.com$/i.test(url.hostname)) return segments.find((part) => /^[A-Za-z0-9_-]{1,64}$/.test(part)) ?? null
    return null
  } catch {
    return null
  }
}

export function douyinDanmakuRoom(descriptor: Pick<MediaDescriptor, 'input' | 'danmakuRoom'>): string | null {
  if (/^douyin:[1-9][0-9]{0,19}$/.test(descriptor.danmakuRoom ?? '')) return descriptor.danmakuRoom!
  const parsed = parseDouyinInput(descriptor.input)
  if (parsed?.kind === 'room') return `douyin:${parsed.room}`
  const typed = parseRoomInput(descriptor.input)
  return typed?.platform === 'douyin' ? `douyin:${typed.room}` : null
}

export function sourceDanmakuRoom(source: MediaDescriptor | null): { key: string; name: string; platform: RoomPlatform } | null {
  if (!source) return null
  const { platform, sourceRoom, danmakuRoom, input } = source
  const name = roomFromInput(input)
  if (platform === 'douyin') {
    const key = douyinDanmakuRoom(source)
    return key ? { key, name: key.slice('douyin:'.length), platform } : null
  }
  if (platform === 'huya' || platform === 'bilibili') {
    const key = danmakuRoom ?? sourceRoom ?? (platform === 'huya' ? name : null)
    const room = key?.replace(new RegExp(`^${platform}:`), '')
    const pattern = platform === 'huya' ? /^[A-Za-z0-9_-]{1,64}$/ : /^[1-9]\d{0,11}$/
    return room && pattern.test(room) ? { key: `${platform}:${room}`, name: name ?? room, platform } : null
  }
  if (platform === 'douyu' && danmakuRoom && /^[1-9]\d{0,11}$/.test(danmakuRoom)) {
    return { key: danmakuRoom, name: name ?? danmakuRoom, platform }
  }
  return null
}

/**
 * Parse a manual danmaku room input from URL, platform-prefixed text, or bare room identifier.
 * Bare numeric rooms keep Douyu's historical unprefixed format when `fallbackPlatform === 'douyu'`.
 */
export function parseDanmakuRoomInput(
  raw: string,
  fallbackPlatform: RoomPlatform = 'douyu',
): { key: string; name: string; platform: RoomPlatform; douyuLookup?: string } | null {
  const value = raw.trim()
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null

  const typed = parseRoomInput(value)
  if (typed) {
    const platform = typed.platform ?? fallbackPlatform
    if (platform === 'douyu') {
      if (/^[1-9]\d{0,11}$/.test(typed.room)) return { key: typed.room, name: typed.room, platform: 'douyu' }
      return { key: typed.room, name: typed.room, platform: 'douyu', douyuLookup: typed.room }
    }
    if (platform === 'bilibili') {
      return /^[1-9]\d{0,11}$/.test(typed.room) ? { key: `bilibili:${typed.room}`, name: typed.room, platform: 'bilibili' } : null
    }
    if (platform === 'huya') {
      return /^[A-Za-z0-9_-]{1,64}$/.test(typed.room) ? { key: `huya:${typed.room}`, name: typed.room, platform: 'huya' } : null
    }
    if (platform === 'douyin') {
      return /^[1-9]\d{0,19}$/.test(typed.room) ? { key: `douyin:${typed.room}`, name: typed.room, platform: 'douyin' } : null
    }
  }

  const douyin = parseDouyinInput(value)
  if (douyin?.kind === 'room') {
    return { key: `douyin:${douyin.room}`, name: douyin.room, platform: 'douyin' }
  }

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '')
  if (host === 'live.bilibili.com') {
    const room = url.pathname.split('/').filter(Boolean)[0]
    return room && /^[1-9]\d{0,11}$/.test(room) ? { key: `bilibili:${room}`, name: room, platform: 'bilibili' } : null
  }
  if (host === 'huya.com' && ['huya.com', 'www.huya.com', 'm.huya.com'].includes(url.hostname.toLowerCase())) {
    const room = /^\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname)?.[1]
    return room ? { key: `huya:${room}`, name: room, platform: 'huya' } : null
  }
  if (host === 'douyu.com' || host.endsWith('.douyu.com')) {
    const rid = url.searchParams.get('rid')
    if (rid && /^[1-9]\d{0,11}$/.test(rid)) return { key: rid, name: rid, platform: 'douyu' }
    const segment = url.pathname.split('/').filter(Boolean)[0]
    if (!segment || !/^[A-Za-z0-9_-]{1,32}$/.test(segment)) return null
    if (/^[1-9]\d{0,11}$/.test(segment)) return { key: segment, name: segment, platform: 'douyu' }
    return { key: segment, name: segment, platform: 'douyu', douyuLookup: url.href }
  }
  return null
}
