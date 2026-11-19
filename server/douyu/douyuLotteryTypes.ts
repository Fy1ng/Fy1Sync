export const DOUYU_LOTTERY_POLL_MS = 15_000

export interface DouyuLotteryActivity {
  id: string
  room: string
  prize: string
  prizeCount: number | null
  startsAt: number
  endsAt: number
  joinType: number | null
  command: string | null
  conditions: string[]
  eligibility: 'unknown'
  gift: { id: string | null; name: string | null; count: number | null; priceOriginal: string | null } | null
  cost: { currency: 'YUCHI' | 'YUWAN'; totalMinor: number; scale: 100 | 1 } | null
}

export interface DouyuLotterySnapshot {
  room: string
  serverNow: number | null
  status: 'active' | 'empty' | 'unavailable'
  activity: DouyuLotteryActivity | null
}
