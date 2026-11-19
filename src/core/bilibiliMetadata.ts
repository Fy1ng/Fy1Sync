export interface BilibiliEmote {
  text: string
  url: string
}

export interface BilibiliSuperChat {
  id: string
  price: number
  duration: number
  endsAt?: number
  background: string
  color: string
}

export interface BilibiliSender {
  admin?: boolean
  gloryLevel?: number
  siteLevel?: number
  guardLevel?: 0 | 1 | 2 | 3
  medal?: { name: string; level: number; anchorUid?: string; anchorName?: string; worn?: boolean }
}

export interface BilibiliGift {
  id?: string
  name: string
  quantity?: number
  payment: 'paid' | 'free' | 'unknown'
  fromBag?: boolean
  comboId?: string
  comboTotal?: number
}

export interface BilibiliMetadata {
  bilibiliUid?: string
  emotes?: BilibiliEmote[]
  bilibiliEmoteKind?: 'inline' | 'image'
  superChat?: BilibiliSuperChat
  bilibiliSender?: BilibiliSender
  bilibiliGift?: BilibiliGift
}

export function bilibiliRoomNumber(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw : Number.isSafeInteger(raw) ? String(raw) : ''
  return /^[1-9]\d{0,11}$/.test(value) ? value : undefined
}

export function bilibiliId(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw : Number.isSafeInteger(raw) ? String(raw) : ''
  return /^[1-9]\d{0,19}$/.test(value) ? value : undefined
}

export function bilibiliCount(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined
}

export function bilibiliFlag(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return undefined
}

export function bilibiliText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max)
  return text.trim() ? text : undefined
}

export function bilibiliImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
    if (!['http:', 'https:'].includes(url.protocol) || !/^[a-z0-9-]+\.hdslb\.com$/.test(url.hostname)
      || url.port || url.username || url.password || !url.pathname.startsWith('/bfs/') || url.hash) return null
    url.protocol = 'https:'
    return url.href
  } catch { return null }
}

function copySender(raw: BilibiliSender): BilibiliSender | undefined {
  const name = bilibiliText(raw.medal?.name, 80)
  const level = bilibiliCount(raw.medal?.level, 1000)
  const guard = bilibiliCount(raw.guardLevel, 3) as BilibiliSender['guardLevel']
  const sender = {
    admin: bilibiliFlag(raw.admin),
    gloryLevel: bilibiliCount(raw.gloryLevel, 1000),
    siteLevel: bilibiliCount(raw.siteLevel, 1000),
    guardLevel: guard,
    medal: name && level ? {
      name, level,
      anchorUid: bilibiliId(raw.medal?.anchorUid),
      anchorName: bilibiliText(raw.medal?.anchorName, 128),
      worn: bilibiliFlag(raw.medal?.worn),
    } : undefined,
  }
  return Object.values(sender).some(value => value !== undefined) ? sender : undefined
}

export function copyBilibiliMetadata(raw: BilibiliMetadata): BilibiliMetadata {
  const result: BilibiliMetadata = {}
  const uid = bilibiliId(raw.bilibiliUid)
  if (uid) result.bilibiliUid = uid
  if (Array.isArray(raw.emotes)) {
    const emotes = raw.emotes.slice(0, 32).flatMap(emote => {
      const url = bilibiliImageUrl(emote?.url)
      return url && typeof emote.text === 'string' && emote.text.length > 0 && emote.text.length <= 100
        ? [{ text: emote.text, url }] : []
    })
    if (emotes.length) {
      result.emotes = emotes
      result.bilibiliEmoteKind = raw.bilibiliEmoteKind === 'image' ? 'image' : 'inline'
    }
  }
  const sc = raw.superChat
  const scId = bilibiliId(sc?.id)
  if (sc && scId && Number.isFinite(sc.price) && sc.price > 0 && sc.price <= 1e8
    && Number.isFinite(sc.duration) && sc.duration > 0 && sc.duration <= 86_400) {
    result.superChat = {
      id: scId, price: sc.price, duration: sc.duration, endsAt: bilibiliCount(sc.endsAt),
      background: /^#[a-f\d]{6}$/i.test(sc.background) ? sc.background : '#1565c0',
      color: /^#[a-f\d]{6}$/i.test(sc.color) ? sc.color : '#ffffff',
    }
  }
  if (raw.bilibiliSender) {
    const sender = copySender(raw.bilibiliSender)
    if (sender) result.bilibiliSender = sender
  }
  const gift = raw.bilibiliGift
  const giftName = bilibiliText(gift?.name, 128)
  if (gift && giftName) result.bilibiliGift = {
    id: bilibiliId(gift.id), name: giftName, quantity: bilibiliCount(gift.quantity) || undefined,
    payment: gift.payment === 'paid' || gift.payment === 'free' ? gift.payment : 'unknown',
    fromBag: bilibiliFlag(gift.fromBag), comboId: bilibiliText(gift.comboId, 128),
    comboTotal: bilibiliCount(gift.comboTotal) || undefined,
  }
  return result
}

export function bilibiliColor(value: unknown): string {
  const color = bilibiliCount(value, 0xffffff)
  return color === undefined ? '#ffffff' : `#${color.toString(16).padStart(6, '0')}`
}

export function emoteSource(raw: unknown): string | undefined {
  const url = bilibiliImageUrl(raw)
  return url ? `app://app/bilibili-emote?url=${encodeURIComponent(url)}` : undefined
}

export function splitBilibiliText(text: string, emotes: BilibiliEmote[] = []): Array<{ text: string; url?: string }> {
  const parts: Array<{ text: string; url?: string }> = []
  const valid = copyBilibiliMetadata({ emotes }).emotes ?? []
  let offset = 0
  while (offset < text.length) {
    let next = text.length
    let match: BilibiliEmote | undefined
    for (const emote of valid) {
      const at = text.indexOf(emote.text, offset)
      if (at >= 0 && (at < next || (at === next && match && emote.text.length > match.text.length))) {
        next = at
        match = emote
      }
    }
    if (next > offset) parts.push({ text: text.slice(offset, next) })
    if (!match) break
    parts.push({ text: match.text, url: match.url })
    offset = next + match.text.length
  }
  return parts
}
