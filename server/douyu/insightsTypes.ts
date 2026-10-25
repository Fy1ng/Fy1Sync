/** Public, credential-free DTOs shared with the desktop bridge. Times are Unix milliseconds. */
export interface DouyuFollowedRoom {
  room: string
  roomName: string
  nickname: string
  live: boolean | null
  replay: boolean | null
  startedAt: number | null
  /** Platform popularity is deliberately not described as a count of viewers. */
  popularity: number | null
  url: string
}

export interface DouyuFollowedRooms {
  accountId: string
  checkedAt: number
  coverage: 'all-pages' | 'partial'
  pageCount: number
  rooms: DouyuFollowedRoom[]
  reason: string | null
}

export interface DouyuRoomInfo {
  room: string
  checkedAt: number
  roomName: string
  nickname: string
  ownerUid: string | null
  live: boolean | null
  replay: boolean | null
  startedAt: number | null
  lastStartedAt: number | null
  popularity: number | null
  /** h5room.online is not reliable evidence of real concurrent viewers. */
  viewers: null
  source: 'douyu-h5room'
}

export interface DouyuBadgeAge {
  room: string
  badgeName: string
  acquiredAt: number | null
  heldDays: number | null
}

export interface DouyuBadgeAges {
  accountId: string
  checkedAt: number
  coverage: 'returned-page'
  badges: DouyuBadgeAge[]
}

export interface DouyuSpendCategory { category: string; amountMinor: number; entries: number }
export interface DouyuSpendSource {
  source: 'gift-consumption' | 'diamond-fans'
  coverage: 'all-pages' | 'partial'
  pageCount: number
  entries: number
  amountMinor: number
  categories: DouyuSpendCategory[]
  reason: string | null
}
export interface DouyuMonthlySpending {
  accountId: string
  checkedAt: number
  month: string
  timeZone: 'Asia/Shanghai'
  currency: 'CNY'
  unit: 'fen'
  sources: DouyuSpendSource[]
  /** Null when pagination or overlap between the two ledgers cannot be proven. */
  totalMinor: number | null
  aggregation: 'complete' | 'partial' | 'unreconciled'
  message: string
}

export interface DouyuWatchTime {
  accountId: string
  room: string
  checkedAt: number
  seconds: number | null
  source: 'douyu-today-watch'
}

export interface DouyuRankEntry {
  uid: string | null
  nickname: string
  /** Raw ranklist gold units. The public client displays gold / 100. */
  gold: number | null
  contribution: number | null
}
export interface DouyuRankSnapshot {
  room: string
  receivedAt: number
  source: 'anonymous-ranklist'
  unit: 'douyu-gold-divided-by-100'
  /** No conversion from a contribution score into fiat is asserted. */
  currency: null
  day: DouyuRankEntry[] | null
  week: DouyuRankEntry[] | null
  all: DouyuRankEntry[] | null
}

export type DouyuRoomSignal =
  | { kind: 'live'; room: string; receivedAt: number; live: boolean; replay: boolean | null }
  | { kind: 'nobles'; room: string; receivedAt: number; count: number }
  | { kind: 'ranks'; room: string; receivedAt: number; ranks: DouyuRankSnapshot }

/** Prices must come from a trusted main-process catalog adapter, never a renderer patch. */
export interface DouyuGiftPrice {
  room?: string
  kind: 'gift' | 'prop'
  id: string
  amountMinor: number
  currency: 'YUCHI'
  source: string
  checkedAt: number
}

export interface DouyuRoomInsights {
  room: string
  observedSince: number
  checkedAt: number
  connected: boolean
  live: boolean | null
  replay: boolean | null
  startedAt: number | null
  lastStartedAt: number | null
  broadcastSeconds: number | null
  localWatchSeconds: number
  viewers: null
  uniqueChatters: number
  uniqueGiftSenders: number
  nobles: { count: number; receivedAt: number } | null
  gifts: {
    count: number
    knownValueMinor: number
    unknownValueCount: number
    totalValueMinor: number | null
    currency: 'YUCHI'
    scale: 100
    valuation: 'catalog-nominal'
  }
  ranks: DouyuRankSnapshot | null
  coverage: {
    source: 'received-events'
    /** The anonymous stream is never a complete server-side audience census. */
    completeRoomHistory: false
    disconnected: boolean
    droppedEvents: number
    unknownSenderEvents: number
    uniqueUsersTruncated: boolean
  }
}

export interface DouyuLiveNotification {
  id: string
  room: string
  occurredAt: number
  source: 'anonymous-rss' | 'follow-list'
}

export type DouyuInsightsEvent =
  | { type: 'changed'; room: string }
  | { type: 'live'; notification: DouyuLiveNotification }
  | { type: 'monitor-error'; accountId: string; message: string }
