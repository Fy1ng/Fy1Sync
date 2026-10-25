import { validDouyuRoom } from '../platforms/douyuRoom'
import { unescapeStt, type DanmakuMessage } from './douyuProtocol'
import type { DouyuRankEntry, DouyuRankSnapshot, DouyuRoomSignal } from '../douyu/insightsTypes'

const MAX_LIST_BYTES = 128 * 1024
const MAX_ENTRIES = 200
const MAX_GOLD = 1_000_000_000_000_000
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '').trim().slice(0, 80)
const integer = (value: unknown, max: number): number | null => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n <= max ? n : null
}

/** ranklist embeds a list of STT records; unescape at each structural layer only. */
export function parseDouyuRankList(raw: unknown): DouyuRankEntry[] | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_LIST_BYTES) return null
  if (raw === '') return []
  let value = raw
  // A flat parseStt result has already removed the outer frame's escaping.
  for (let depth = 0; depth < 3 && !value.includes('@=') && value.includes('@A'); depth++) value = unescapeStt(value)
  const rows = value.split('//').filter(Boolean)
  if (rows.length > MAX_ENTRIES) return null
  const result: DouyuRankEntry[] = []
  const seen = new Set<string>()
  for (const encoded of rows) {
    let row = encoded
    for (let depth = 0; depth < 3 && !row.includes('@=') && row.includes('@A'); depth++) row = unescapeStt(row)
    const fields: Record<string, string> = Object.create(null) as Record<string, string>
    for (const pair of row.split('/').filter(Boolean)) {
      const separator = pair.indexOf('@=')
      if (separator <= 0 || separator > 64) return null
      const key = unescapeStt(pair.slice(0, separator))
      if (Object.hasOwn(fields, key)) return null
      fields[key] = unescapeStt(pair.slice(separator + 2))
    }
    if (typeof fields.nickname !== 'string') return null
    const nickname = clean(fields.nickname)
    if (!nickname) return null
    const uid = /^[1-9][0-9]{0,19}$/.test(fields.uid ?? '') ? fields.uid! : null
    const gold = integer(fields.gold, MAX_GOLD)
    // Unknown gold stays unknown. Nicknames are not unique identities.
    if (uid && seen.has(uid)) return null
    if (uid) seen.add(uid)
    result.push({ uid, nickname, gold, contribution: gold === null ? null : gold / 100 })
  }
  return result
}

/** Whitelisted public room events. No raw protocol fields leave this function. */
export function parseDouyuRoomSignal(message: DanmakuMessage, room: string, receivedAt: number): DouyuRoomSignal | null {
  if (!validDouyuRoom(room) || !Number.isSafeInteger(receivedAt) || receivedAt < 0 ||
      (message.rid !== undefined && message.rid !== room)) return null
  if (message.type === 'rss') {
    if (!['0', '1', '2'].includes(message.ss ?? '') || (message.ivl !== undefined && !['0', '1'].includes(message.ivl))) return null
    return { kind: 'live', room, receivedAt, live: message.ss === '1', replay: message.ivl === undefined ? null : message.ivl === '1' }
  }
  if (message.type === 'oni') {
    const count = integer(message.vn, 1_000_000_000)
    return count === null ? null : { kind: 'nobles', room, receivedAt, count }
  }
  if (message.type !== 'ranklist') return null
  const day = message.list_day === undefined ? null : parseDouyuRankList(message.list_day)
  const week = message.list === undefined ? null : parseDouyuRankList(message.list)
  const all = message.list_all === undefined ? null : parseDouyuRankList(message.list_all)
  if (day === null && week === null && all === null) return null
  const ranks: DouyuRankSnapshot = {
    room, receivedAt, source: 'anonymous-ranklist', unit: 'douyu-gold-divided-by-100', currency: null, day, week, all,
  }
  return { kind: 'ranks', room, receivedAt, ranks }
}
