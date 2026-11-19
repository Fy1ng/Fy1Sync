import { douyinMessageRoom } from './douyinMessage'
import type { DouyinMessageMetadata } from '../../server/danmaku/douyinProtocol'

export const DOUYIN_LOTTERY_POLL_MS = 20_000

export interface DouyinLotteryActivity {
  id: string
  prize: {
    kind: 'virtual-currency' | 'physical'
    name: string
    description: string
    count: number | null
    winners: number | null
  }
  conditions: Array<{ type: number; label: string }>
  commentCommand: string | null
  webSupport: 'app-may-be-required' | 'unknown'
  platformTime: number
  drawTime: number
}

export interface DouyinLotteryTarget {
  room: string
  roomId: string
}

export type DouyinLotterySnapshot = DouyinLotteryTarget & { observedAt: number } & (
  | { status: 'active'; activity: DouyinLotteryActivity }
  | { status: 'empty' | 'unavailable'; activity: null }
)

export interface DouyinLotteryComment {
  room: string
  platform?: string
  receivedAt: number
  text: string
  system?: boolean
  douyin?: Pick<DouyinMessageMetadata, 'roomId' | 'method' | 'plainTextExact'>
}

export interface DouyinLotteryCommentHint extends DouyinLotteryTarget {
  activityId: string
  kind: 'matching-command'
}

export function douyinLotteryId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
}

export function douyinLotteryRemaining(activity: DouyinLotteryActivity, elapsedMs: number): number {
  return Math.max(0, Math.ceil(activity.drawTime - activity.platformTime - Math.max(0, elapsedMs) / 1000))
}

export function matchDouyinLotteryComment(
  snapshot: DouyinLotterySnapshot | null,
  message: DouyinLotteryComment,
): DouyinLotteryCommentHint | null {
  if (snapshot?.status !== 'active' || message.platform !== 'douyin'
    || !douyinMessageRoom(message.room) || message.room !== snapshot.room
    || !douyinLotteryId(message.douyin?.roomId) || message.douyin.roomId !== snapshot.roomId
    || message.system || message.douyin.method !== 'WebcastChatMessage' || message.douyin.plainTextExact !== true) return null
  const { activity } = snapshot
  if (!activity.commentCommand || message.text !== activity.commentCommand) return null
  const elapsed = message.receivedAt - snapshot.observedAt
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= DOUYIN_LOTTERY_POLL_MS
    || douyinLotteryRemaining(activity, elapsed) === 0) return null
  return { kind: 'matching-command', room: snapshot.room, roomId: snapshot.roomId, activityId: activity.id }
}
