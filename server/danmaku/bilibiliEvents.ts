import { randomUUID } from 'node:crypto'
import {
  bilibiliCount, bilibiliFlag, bilibiliId, bilibiliImageUrl, bilibiliRoomNumber, bilibiliText, copyBilibiliMetadata,
  type BilibiliMetadata, type BilibiliSender,
} from '../../src/core/bilibiliMetadata'
import { bilibiliObject } from '../platforms/bilibiliWeb'
import type { ChatMessage } from './types'

export type BilibiliChatMessage = Omit<ChatMessage, 'platform' | 'room'> & BilibiliMetadata & {
  platform: 'bilibili'
  room: `bilibili:${string}`
}

type BilibiliRoomEvent = { platform: 'bilibili'; room: `bilibili:${string}`; receivedAt: number }
export type BilibiliCountSignal = BilibiliRoomEvent & { kind: 'popularity' | 'watched' | 'likes'; count: number }
export type BilibiliSuperChatRemoval = BilibiliRoomEvent & { kind: 'super-chat-delete'; ids: string[] }
export type BilibiliRoomSignal = BilibiliCountSignal | BilibiliSuperChatRemoval

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readExtra(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return bilibiliObject(value)
  try { return bilibiliObject(JSON.parse(value)) } catch { return {} }
}

function readSender(
  user: Record<string, unknown>, data: Record<string, unknown>, legacyMedal: unknown[] = [],
): BilibiliSender {
  const medal = bilibiliObject(user.medal)
  const base = bilibiliObject(user.base)
  const guard = bilibiliObject(user.guard)
  const name = bilibiliText(medal.name ?? legacyMedal[1] ?? data.fans_medal_name, 80)
  const level = bilibiliCount(medal.level ?? legacyMedal[0] ?? data.fans_medal_level, 1000)
  return {
    admin: bilibiliFlag(data.is_admin),
    gloryLevel: bilibiliCount(data.glory_level ?? bilibiliObject(user.glory).level, 1000),
    siteLevel: bilibiliCount(base.site_level ?? data.site_level, 1000),
    guardLevel: bilibiliCount(guard.level ?? data.guard_level, 3) as BilibiliSender['guardLevel'],
    medal: name && level ? {
      name, level,
      anchorUid: bilibiliId(medal.target_id ?? legacyMedal[12]),
      anchorName: bilibiliText(medal.target_name ?? legacyMedal[2], 128),
      worn: bilibiliFlag(medal.wearing_status ?? data.fans_medal_wearing_status),
    } : undefined,
  }
}

export function parseBilibiliRoomEvent(raw: unknown, canonicalRoom: string, receivedAt: number): BilibiliChatMessage | BilibiliRoomSignal | null {
  if (!bilibiliRoomNumber(canonicalRoom)) return null
  const message = bilibiliObject(raw)
  if (typeof message.cmd !== 'string') return null
  const command = message.cmd.split(':', 1)[0]
  const data = bilibiliObject(message.data)
  if (data.room_id !== undefined && bilibiliRoomNumber(data.room_id) !== canonicalRoom) return null
  const room: BilibiliRoomEvent = { platform: 'bilibili', room: `bilibili:${canonicalRoom}`, receivedAt }
  if (command === 'WATCHED_CHANGE' || command === 'LIKE_INFO_V3_UPDATE') {
    const kind = command === 'WATCHED_CHANGE' ? 'watched' : 'likes'
    const count = bilibiliCount(kind === 'watched' ? data.num : data.click_count)
    return count === undefined ? null : { ...room, kind, count }
  }
  if (command === 'SUPER_CHAT_MESSAGE_DELETE') {
    const ids = [...new Set(array(data.ids).slice(0, 512).flatMap(value => bilibiliId(value) ?? []))]
    return ids.length ? { ...room, kind: 'super-chat-delete', ids } : null
  }

  const user = bilibiliObject(data.uinfo)
  const defaultName = bilibiliText(bilibiliObject(user.base).name ?? data.uname, 128) ?? '匿名'
  const base = { ...room, color: 0xffffff, level: 0, system: false }
  if (command === 'SUPER_CHAT_MESSAGE') {
    const start = bilibiliCount(data.start_time, 9_999_999_999)
    const end = bilibiliCount(data.end_time, 9_999_999_999)
    const metadata = copyBilibiliMetadata({
      bilibiliUid: bilibiliId(data.uid ?? user.uid),
      bilibiliSender: readSender(user, data),
      superChat: {
        id: bilibiliId(data.id) ?? '', price: typeof data.price === 'number' ? data.price : 0,
        duration: start && end && end > start ? end - start : bilibiliCount(data.time) ?? 0,
        endsAt: end ? end * 1000 : undefined, background: String(data.background_bottom_color ?? ''), color: String(data.message_font_color ?? ''),
      },
    })
    const text = bilibiliText(data.message, 2000)
    if (!text || !metadata.superChat) return null
    const username = bilibiliText(bilibiliObject(data.user_info).uname, 128) ?? defaultName
    return { ...base, ...metadata, id: `${room.room}:sc:${metadata.superChat.id}`, text, username }
  }
  if (command === 'SEND_GIFT') {
    const name = bilibiliText(data.giftName, 128)
    if (!name) return null
    const paid = bilibiliFlag(data.paid)
    const fromBag = bilibiliFlag(data.bag_gift)
    const combo = bilibiliObject(data.batch_combo_send ?? data.combo_send)
    const metadata = copyBilibiliMetadata({
      bilibiliUid: bilibiliId(data.uid ?? user.uid),
      bilibiliSender: readSender(user, data),
      bilibiliGift: {
        id: bilibiliId(data.giftId), name, quantity: bilibiliCount(data.num),
        payment: paid === true ? 'paid' : paid === false || data.coin_type === 'silver' ? 'free' : 'unknown',
        fromBag, comboId: bilibiliText(combo.batch_combo_id ?? data.batch_combo_id, 128),
        comboTotal: bilibiliCount(combo.batch_combo_num ?? combo.combo_num),
      },
    })
    return { ...base, ...metadata, id: `${room.room}:gift:${bilibiliText(data.tid, 80) ?? randomUUID()}`, text: name, username: defaultName }
  }
  if (command !== 'DANMU_MSG') return null
  const info = array(message.info)
  if (typeof info[1] !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(info[1])) return null
  const text = bilibiliText(info[1], 2000)
  if (!text) return null
  const params = array(info[0])
  const sender = array(info[2])
  const extraHolder = bilibiliObject(params[15])
  const extra = readExtra(extraHolder.extra)
  const wholeImage = bilibiliImageUrl(bilibiliObject(params[13]).url)
  const emotes = Object.entries(bilibiliObject(extra.emots)).slice(0, 31).flatMap(([text, value]) => {
    const url = bilibiliObject(value).url
    return typeof url === 'string' ? [{ text, url }] : []
  })
  if (wholeImage) emotes.unshift({ text, url: wholeImage })
  const dmUser = bilibiliObject(extraHolder.user ?? extra.user)
  const metadata = copyBilibiliMetadata({
    bilibiliUid: bilibiliId(sender[0]) ?? bilibiliId(dmUser.uid),
    emotes,
    bilibiliEmoteKind: wholeImage ? 'image' : 'inline',
    bilibiliSender: readSender(dmUser, { is_admin: sender[2], guard_level: info[7] }, array(info[3])),
  })
  return {
    ...base, ...metadata, id: `${room.room}:dm:${bilibiliText(extra.id_str, 80) ?? randomUUID()}`,
    text, username: bilibiliText(sender[1], 128) ?? '匿名',
    color: bilibiliCount(params[3], 0xffffff) ?? base.color,
  }
}
