import { parseSourceInput } from './mediaSources'
import { parseDouyinInput } from './douyinInput'

/** Normalize aliases without fetching media or changing the original saved input. */
export function savedRoomInput(platform: string, input: string): string {
  const value = input.trim()
  const typed = platform === 'bilibili' ? /^(?:b|bili|bilibili|b站|哔哩哔哩)\s*[:：]?\s*([1-9]\d{0,11})$/i.exec(value)
    : platform === 'douyu' ? /^(?:dy|douyu|斗鱼)\s*[:：]?\s*([1-9]\d{0,11})$/i.exec(value)
      : platform === 'huya' ? /^(?:(?:hy|huya)(?:\s*[:：]\s*|\s+)|虎牙\s*[:：]?\s*)([A-Za-z0-9_-]{1,64})$/i.exec(value) : null
  const bare = typed?.[1] ?? value.replace(/^(?:(?:douyu|bilibili|huya|douyin)(?:\s*[:：]\s*|\s+)|(?:斗鱼|哔哩哔哩|b站|虎牙|抖音)\s*[:：]?\s*)/i, '')
  if (platform === 'douyin') return parseDouyinInput(bare)?.url ?? value
  if (platform === 'douyu' && /^[1-9]\d{0,11}$/.test(bare)) return `https://www.douyu.com/${bare}`
  if (platform === 'bilibili' && /^[1-9]\d{0,11}$/.test(bare)) return `https://live.bilibili.com/${bare}`
  if (platform === 'huya' && /^[A-Za-z0-9_-]{1,64}$/.test(bare)) return `https://www.huya.com/${bare}`
  if (platform === 'twitch' && /^[A-Za-z0-9_]{3,25}$/.test(value)) return `https://www.twitch.tv/${value.toLowerCase()}`
  if (platform === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(value)) return `https://www.youtube.com/watch?v=${value}`
  return value
}

export function savedRoomKey(platform: string, input: string): string {
  const normalized = savedRoomInput(platform, input)
  const parsed = parseSourceInput(normalized)
  if (parsed.ok && parsed.platform === platform && parsed.channel) return `${platform}:${platform === 'twitch' ? parsed.channel.toLowerCase() : parsed.channel}`
  if (platform === 'youtube') {
    try {
      const url = new URL(/^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`)
      const id = url.searchParams.get('v') ?? (/^(?:www\.)?youtu\.be$/.test(url.hostname) ? url.pathname.slice(1) : /^\/(?:live|embed)\/([^/]+)$/.exec(url.pathname)?.[1])
      const path = url.pathname.replace(/\/(?:live|streams|featured)\/?$/, '').replace(/\/$/, '')
      return `youtube:${id ? `video:${id}` : path.startsWith('/@') ? path.toLowerCase() : path}`
    } catch { /* Validation belongs to the store and collector. */ }
  }
  return `${platform}:${normalized}`
}
