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
