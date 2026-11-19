import { validDouyuRoom } from '../platforms/douyuRoom'
import { multiplyGiftMoney } from './inventoryService'
import type { DouyuGiftCatalog } from './inventoryTypes'
import { rewardData, rewardEnvelope, rewardId, rewardInteger } from './rewardProtocol'
import type { DouyuLotteryActivity } from './douyuLotteryTypes'

const RANGES = ['全部水友', '需要关注主播', '需要粉丝团身份', '需要关注和粉丝团身份', '需要钻石粉丝身份', '需要关注和钻石粉丝身份']
const text = (value: unknown, max = 512): string | null => typeof value === 'string' && value.trim()
  && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value : null
const epoch = (value: unknown): number | null => {
  const seconds = rewardInteger(value)
  return seconds !== null && seconds >= 1_577_836_800 && seconds <= 4_102_444_800 ? seconds * 1000 : null
}

export function parseDouyuLottery(payload: unknown, room: string, serverNow: number): DouyuLotteryActivity | null {
  if (!validDouyuRoom(room) || !Number.isFinite(serverNow)) throw new Error('Invalid lottery context')
  const data = rewardEnvelope(payload)
  if (Object.keys(data).length === 0) return null
  if (rewardId(data.room_id) !== room) throw new Error('Lottery room mismatch')
  const status = rewardInteger(data.activity_status)
  if (status === null) throw new Error('Invalid lottery status')
  if (status !== 4) return null
  const id = rewardId(data.activity_id)
  const condition = rewardData(data.join_condition)
  const joinType = rewardInteger(data.join_type)
  const startsAt = epoch(data.start_at)
  const duration = rewardInteger(condition.expire_time)
  const timedEnd = startsAt !== null && (joinType === 1 || joinType === 2) && duration !== null && duration > 0 && duration <= 86_400
    ? startsAt + duration * 1000 : null
  const stopped = epoch(data.stop_at)
  const endsAt = stopped !== null && timedEnd !== null ? Math.min(stopped, timedEnd) : stopped ?? timedEnd
  const prize = text(data.prize_name)
  if (!id || !prize || startsAt === null || endsAt === null || endsAt <= startsAt || endsAt - startsAt > 86_400_000) {
    throw new Error('Lottery timing or identity unconfirmed')
  }
  if (startsAt > serverNow || endsAt <= serverNow) return null
  const range = rewardInteger(condition.lottery_range)
  const command = joinType === 1 ? text(condition.command_content) : null
  const conditions = [range !== null && RANGES[range] ? RANGES[range]! : '参与人群限制待官方确认']
  if (joinType === 1) conditions.push(command ? '需登录并发送官方口令' : '需登录, 口令内容待官方确认')
  else if (joinType === 2) conditions.push('需登录并赠送指定数量的礼物')
  else if (joinType === 3) conditions.push('需登录并赠送指定礼物参与爆灯抽奖')
  else conditions.push('参与方式待官方确认')
  if (data.otherConditionType !== undefined && rewardInteger(data.otherConditionType) !== 0) {
    const name = text(data.otherConditionName), value = text(data.otherConditionValue)
    conditions.push(`附加条件 ${[name, value].filter(Boolean).join(' / ') || '待官方确认'}`)
  }
  const count = rewardInteger(condition.gift_num)
  const rawPrice = condition.gift_price
  const gift = joinType === 2 || joinType === 3 ? {
    id: rewardId(condition.gift_id), name: text(condition.gift_name), count: count && count <= 1_000_000 ? count : null,
    priceOriginal: text(typeof rawPrice === 'number' ? String(rawPrice) : rawPrice, 64),
  } : null
  return { id, room, prize, prizeCount: rewardInteger(data.prize_num), startsAt, endsAt, joinType, command,
    conditions, eligibility: 'unknown', gift, cost: null }
}

export function addDouyuLotteryCost(activity: DouyuLotteryActivity, catalog: DouyuGiftCatalog): DouyuLotteryActivity {
  if (!activity.gift?.id || !activity.gift.count) return activity
  if (catalog.room !== activity.room) return activity
  const gift = activity.gift
  const item = catalog.items.find(entry => entry.giftId === gift.id)
  const price = item?.unitPrice && multiplyGiftMoney(item.unitPrice, activity.gift.count)
  return { ...activity, gift: { ...gift, name: gift.name ?? item?.name ?? null },
    cost: price ? { currency: price.currency, totalMinor: price.amountMinor, scale: price.scale } : null }
}
