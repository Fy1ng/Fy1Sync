import { bilibiliRoomNumber } from '../../src/core/bilibiliMetadata'
import type { BilibiliChatMessage, BilibiliCountSignal } from '../danmaku/bilibiliEvents'
import type { DanmakuRate } from '../danmaku/messageHistory'
import type { BilibiliRoomIdentity } from './bilibiliWeb'

type RoomMetrics = Partial<Record<BilibiliCountSignal['kind'], { count: number; checkedAt: number }>>
export type BilibiliRoomSnapshot = ReturnType<typeof summarizeBilibiliRoom>

export function summarizeBilibiliRoom(input: {
  room: string
  messages: readonly BilibiliChatMessage[]
  rate: Pick<DanmakuRate, 'receivedLastMinute'>
  capacity: number
  truncated: boolean
  checkedAt: number
}, metrics: RoomMetrics = {}) {
  const { room, rate, capacity, truncated, checkedAt } = input
  if (!room.startsWith('bilibili:') || !bilibiliRoomNumber(room.slice(9))) throw new Error('B 站房间号无效.')
  const items = input.messages.filter(message => message.platform === 'bilibili' && message.room === room && !message.system)
  const chats = items.filter(message => !message.superChat && !message.bilibiliGift)
  const superChats = items.flatMap(message => message.superChat ?? [])
  return {
    room, rate, capacity, truncated, checkedAt,
    messages: chats.length,
    users: new Set(items.filter(message => !message.bilibiliGift).flatMap(message => message.bilibiliUid ?? [])).size,
    superChats: superChats.length,
    superChatYuan: superChats.reduce((sum, item) => sum + item.price, 0),
    metrics,
  }
}

export class BilibiliRoomMetrics {
  private readonly rooms = new Map<string, RoomMetrics>()

  observe(signal: BilibiliCountSignal): void {
    const fields = this.rooms.get(signal.room) ?? {}
    if ((fields[signal.kind]?.checkedAt ?? -1) > signal.receivedAt) return
    this.rooms.delete(signal.room)
    this.rooms.set(signal.room, { ...fields, [signal.kind]: { count: signal.count, checkedAt: signal.receivedAt } })
    if (this.rooms.size > 64) this.rooms.delete(this.rooms.keys().next().value!)
  }

  read(room: string): RoomMetrics {
    const fields = this.rooms.get(room)
    return fields ? structuredClone(fields) : {}
  }
}

export function bilibiliWatchEvidenceStatus(
  identity: BilibiliRoomIdentity, accountRef: string | null, checkedAt: number,
) {
  const reason = !accountRef ? 'login-required' : !identity.live || !identity.liveStartedAt
    ? 'session-unconfirmed' : 'no-verified-reader'
  return {
    platform: 'bilibili' as const, room: identity.room, accountRef,
    liveStartedAt: identity.liveStartedAt ?? null, checkedAt,
    todaySeconds: null, cumulativeSeconds: null, watchTaskProgress: null,
    reason, officialRoomUrl: `https://live.bilibili.com/${identity.room}`,
  } as const
}
export type BilibiliWatchEvidenceStatus = ReturnType<typeof bilibiliWatchEvidenceStatus>
