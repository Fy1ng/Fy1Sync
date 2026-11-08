export interface BilibiliEmote { text: string; url: string }
export interface BilibiliSuperChat { id: string; price: number; duration: number; background: string; color: string }
export interface BilibiliMetadata { bilibiliUid?: string; emotes?: BilibiliEmote[]; superChat?: BilibiliSuperChat }

export function bilibiliImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (!['http:', 'https:'].includes(url.protocol) || !/^[a-z0-9-]+\.hdslb\.com$/.test(url.hostname)
      || url.port || url.username || url.password || !url.pathname.startsWith('/bfs/')) return null
    url.protocol = 'https:'
    return url.href
  } catch { return null }
}
export function copyBilibiliMetadata(raw: BilibiliMetadata): BilibiliMetadata {
  const result: BilibiliMetadata = {}
  if (typeof raw.bilibiliUid === 'string' && /^[1-9]\d{0,19}$/.test(raw.bilibiliUid)) result.bilibiliUid = raw.bilibiliUid
  if (Array.isArray(raw.emotes)) result.emotes = raw.emotes.slice(0, 32).flatMap(e => {
    const url = bilibiliImageUrl(e?.url)
    return url && typeof e.text === 'string' && e.text.length > 0 && e.text.length <= 100 ? [{ text: e.text, url }] : []
  })
  const sc = raw.superChat
  if (sc && typeof sc.id === 'string' && sc.id.length <= 80 && sc.id.length > 0 && Number.isFinite(sc.price) && sc.price > 0 && sc.price <= 1e8
    && Number.isFinite(sc.duration) && sc.duration > 0) result.superChat = { id: sc.id, price: sc.price, duration: Math.min(600, sc.duration),
      background: /^#[a-f\d]{6}$/i.test(sc.background) ? sc.background : '#1565c0', color: /^#[a-f\d]{6}$/i.test(sc.color) ? sc.color : '#ffffff' }
  return result
}
export function bilibiliColor(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff ? `#${value.toString(16).padStart(6, '0')}` : '#ffffff'
}
export function emoteSource(url: string): string { return `app://app/bilibili-emote?url=${encodeURIComponent(url)}` }
export function splitBilibiliText(text: string, emotes: BilibiliEmote[] = []): Array<{ text: string; url?: string }> {
  const parts: Array<{ text: string; url?: string }> = []
  let offset = 0
  while (offset < text.length) {
    let next = text.length, match: BilibiliEmote | undefined
    for (const e of emotes) { const at = e.text ? text.indexOf(e.text, offset) : -1; if (at >= 0 && at < next) { next = at; match = e } }
    if (next > offset) parts.push({ text: text.slice(offset, next) })
    if (!match) break
    parts.push({ text: match.text, url: match.url }); offset = next + match.text.length
  }
  return parts
}
