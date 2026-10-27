/** Anonymous Huya chat identity. This path is independent of H1 stream state/CDNs. */
import { jsonAfter, parseHuyaRoom } from './huya'
import type { ResolverDeps } from './types'

export type HuyaDanmakuRoom = { room: string; presenterUid: bigint; topSid: bigint; subSid: bigint }

const MAX_PAGE = 2 * 1_048_576
const invalid = () => new Error('无法读取虎牙弹幕房间信息.')
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function identifier(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) return null
  const result = BigInt(value)
  return result <= 0x7fff_ffff_ffff_ffffn ? result : null
}

export function parseHuyaDanmakuPage(raw: string, input: string): HuyaDanmakuRoom {
  if (typeof raw !== 'string' || raw.length > MAX_PAGE || !parseHuyaRoom(input)) throw invalid()
  if (/找不到这个主播|正在整改中|房间已被封禁|主播已被封禁/.test(raw)) throw invalid()
  const page = raw.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&amp;/g, '&')
  const room = record(jsonAfter(page, /\bTT_ROOM_DATA\s*=\s*/, 65_536))
  const profile = record(jsonAfter(page, /\bTT_PROFILE_INFO\s*=\s*/, 65_536))
  const stream = record(jsonAfter(page, /\bstream\s*:\s*/, 1_048_576))
  const data = Array.isArray(stream.data) && stream.data.length <= 100 ? record(stream.data[0]) : {}
  const live = record(data.gameLiveInfo)
  const lines = Array.isArray(data.gameStreamInfoList) && data.gameStreamInfoList.length <= 100 ? data.gameStreamInfoList.map(record) : []
  // Read only named public room structures. Never scan arbitrary page users for a UID.
  const canonical = identifier(room.profileRoom)
  if (canonical === null || canonical <= 0n || canonical > 9_999_999_999_999_999n) throw invalid()
  const presenter = identifier(profile.uid ?? room.uid ?? live.uid ?? live.lUid ?? lines[0]?.lPresenterUid)
  // Biliup registers with zero channels. Keep that fallback when the page omits them.
  const topSid = identifier(room.topSid ?? room.lChannelId ?? live.lChannelId ?? live.topSid ?? 0)
  const subSid = identifier(room.subSid ?? room.lSubChannelId ?? live.lSubChannelId ?? live.subSid ?? 0)
  if (presenter === null || presenter <= 0n || topSid === null || subSid === null) throw invalid()
  return { room: String(canonical), presenterUid: presenter, topSid, subSid }
}

export async function resolveHuyaDanmakuRoom(input: string, fetchText: ResolverDeps['fetchText']): Promise<HuyaDanmakuRoom> {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input)) throw invalid()
  const load = async (room: string) => parseHuyaDanmakuPage(await fetchText(`https://www.huya.com/${room}`, {
    headers: { Referer: 'https://www.huya.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36' },
  }), room)
  try {
    const first = await load(input)
    const resolved = /^\d+$/.test(input) ? first : await load(first.room)
    if ((!/^\d+$/.test(input) && resolved.room !== first.room) || (/^\d+$/.test(input) && resolved.room !== BigInt(input).toString())) throw invalid()
    return resolved
  } catch { throw invalid() }
}
