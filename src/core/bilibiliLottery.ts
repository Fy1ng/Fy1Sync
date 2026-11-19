import type { SourceRole } from './types'
import type { ChatMessage } from '../../server/danmaku/types'
import type { BilibiliMetadata } from './bilibiliMetadata'

export type BilibiliLotteryPhase = 'empty' | 'ongoing' | 'settling' | 'ended' | 'unverified'
  | 'login-required' | 'restricted' | 'unavailable'
export interface BilibiliLotteryActivity {
  id: string
  prize: string
  prizeCount: number | null
  joinType: number
  requireType: number
  requireValue: number | null
  requireText: string
  joinText: string
  messages: string[]
  giftName: string
  giftCount: number | null
  giftPrice: number | null
  joined: boolean | null
}
export interface BilibiliLotterySnapshot {
  room: string | null
  phase: BilibiliLotteryPhase
  activity: BilibiliLotteryActivity | null
  serverNow: number | null
  observedFrom: number | null
  endsAt: number | null
  checkedAt: number
  clockSource: 'payload' | 'http-date' | null
  clockUncertaintyMs: number | null
  reminder: boolean
}
export interface BilibiliLotteryWatch { slot: SourceRole; watchId: string }
export interface BilibiliLotteryMethods {
  readBilibiliLottery: { args: BilibiliLotteryWatch & { input: string; reminders: boolean }; result: BilibiliLotterySnapshot }
  stopBilibiliLottery: { args: BilibiliLotteryWatch; result: { stopped: boolean } }
  setBilibiliLotteryReminders: { args: BilibiliLotteryWatch & { enabled: boolean }; result: { enabled: boolean } }
  openBilibiliLotteryRoom: { args: BilibiliLotteryWatch & { room: string; activityId: string | null }; result: { opened: true } }
}
export type BilibiliLotteryHandlers<Context> = {
  [Method in keyof BilibiliLotteryMethods]: (args: BilibiliLotteryMethods[Method]['args'], context: Context) =>
    BilibiliLotteryMethods[Method]['result'] | Promise<BilibiliLotteryMethods[Method]['result']>
}
export type BilibiliLotteryResult<Value> = { ok: true; value: Value } | { ok: false; code: string; message: string }
export interface BilibiliLotteryClient {
  feature<Method extends keyof BilibiliLotteryMethods>(method: Method, args: BilibiliLotteryMethods[Method]['args']):
    Promise<BilibiliLotteryResult<BilibiliLotteryMethods[Method]['result']>>
  subscribeFeatures?: (listener: (event: { topic: string; data: unknown }) => void) => () => void
}
export const BILIBILI_LOTTERY_METHODS = ['readBilibiliLottery', 'stopBilibiliLottery', 'setBilibiliLotteryReminders', 'openBilibiliLotteryRoom'] as const
export const BILIBILI_LOTTERY_POLL_MS = 30_000
export const BILIBILI_LOTTERY_FRESH_MS = 65_000

export type BilibiliLotteryMessage = Pick<ChatMessage, 'id' | 'text' | 'room' | 'receivedAt' | 'system'>
  & Pick<BilibiliMetadata, 'superChat' | 'bilibiliGift' | 'bilibiliEmoteKind'> & {
  platform: 'bilibili'
  kind?: 'chat' | 'super-chat' | 'gift' | 'announcement'
}
export interface BilibiliLotteryClue {
  kind: 'same-text-clue'
  room: string
  activityId: string
  text: string
  receivedAt: number
  serverReceivedAt: number
  automatic: null
  participated: null
}

export function bilibiliLotteryServerTime(snapshot: BilibiliLotterySnapshot, receivedAt: number): number | null {
  if (snapshot.serverNow === null || snapshot.clockSource === null || snapshot.clockUncertaintyMs === null
    || !Number.isFinite(snapshot.serverNow) || !Number.isFinite(snapshot.clockUncertaintyMs) || snapshot.clockUncertaintyMs < 0
    || !['payload', 'http-date'].includes(snapshot.clockSource)
    || !Number.isFinite(receivedAt) || !Number.isFinite(snapshot.checkedAt)) return null
  const elapsed = receivedAt - snapshot.checkedAt
  if (elapsed < 0 || elapsed > BILIBILI_LOTTERY_FRESH_MS) return null
  return snapshot.serverNow + elapsed
}

export function matchBilibiliLotteryMessage(message: BilibiliLotteryMessage,
  history: readonly BilibiliLotterySnapshot[]): BilibiliLotteryClue | null {
  if (message.platform !== 'bilibili' || message.system || message.superChat || message.bilibiliGift || message.bilibiliEmoteKind
    || (message.kind !== undefined && message.kind !== 'chat')) return null
  const room = message.room.replace(/^bilibili:/, '')
  if (!/^[1-9][0-9]{0,11}$/.test(room)) return null
  const samples = history.filter(snapshot => snapshot.room === room && snapshot.checkedAt <= message.receivedAt)
  const latestTime = Math.max(...samples.map(snapshot => snapshot.checkedAt))
  const latest = samples.filter(snapshot => snapshot.checkedAt === latestTime)
  if (latest.length === 0) return null
  const snapshot = latest[0]!
  if (latest.some(item => item.activity?.id !== snapshot.activity?.id || item.phase !== snapshot.phase
    || item.endsAt !== snapshot.endsAt || item.serverNow !== snapshot.serverNow
    || item.observedFrom !== snapshot.observedFrom || item.clockSource !== snapshot.clockSource
    || item.clockUncertaintyMs !== snapshot.clockUncertaintyMs || item.activity?.joinType !== snapshot.activity?.joinType
    || JSON.stringify(item.activity?.messages) !== JSON.stringify(snapshot.activity?.messages))) return null
  const activity = snapshot.activity
  const at = bilibiliLotteryServerTime(snapshot, message.receivedAt)
  if (snapshot.phase !== 'ongoing' || !activity || activity.joinType !== 0 || at === null
    || snapshot.observedFrom === null || snapshot.endsAt === null || snapshot.clockUncertaintyMs === null
    || !Number.isFinite(snapshot.observedFrom) || !Number.isFinite(snapshot.endsAt) || snapshot.endsAt <= snapshot.observedFrom
    || at - snapshot.clockUncertaintyMs < snapshot.observedFrom || at + snapshot.clockUncertaintyMs >= snapshot.endsAt
    || !activity.messages.includes(message.text)) return null
  return { kind: 'same-text-clue', room, activityId: activity.id, text: message.text,
    receivedAt: message.receivedAt, serverReceivedAt: at, automatic: null, participated: null }
}

export function bilibiliLotteryConditions(activity: BilibiliLotteryActivity): string[] {
  const types: Record<number, string> = { 0: '通过官方福袋按钮发送指定弹幕', 1: '通过官方福袋按钮赠送指定道具', 2: '完成官方游戏任务' }
  const requirements: Record<number, string> = { 0: '无额外身份条件', 1: '需关注主播', 2: '需本房粉丝勋章或粉丝团资格',
    3: '需本房大航海资格', 4: '需直播等级', 5: '需主站等级' }
  const values = [types[activity.joinType] ?? `参与方式待官方确认 (类型 ${activity.joinType})`]
  if (activity.joinText) values.push(activity.joinText)
  const value = activity.requireValue
  if (activity.requireType === 3 && value !== null) {
    values.push(`需本房大航海: ${{ 1: '总督', 2: '提督及以上', 3: '舰长及以上' }[value] ?? `等级 ${value} 待官方确认`}`)
  } else values.push((requirements[activity.requireType] ?? `身份条件待官方确认 (类型 ${activity.requireType})`)
    + (value !== null && value > 0 && activity.requireType > 1 ? `, 要求 ${value}` : ''))
  if (activity.requireText) values.push(activity.requireText)
  if (activity.joinType === 1) {
    values.push(`指定道具: ${activity.giftName || '待官方确认'}${activity.giftCount === null ? '' : ` x ${activity.giftCount}`}`)
    values.push(activity.giftPrice === null ? '赠送成本待官方确认' : `平台道具单价: ${activity.giftPrice} 金瓜子, 实际扣费以官方确认为准`)
  }
  return [...new Set(values)]
}
