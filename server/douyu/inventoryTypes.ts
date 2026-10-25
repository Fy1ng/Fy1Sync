export type DouyuGiftCurrency = 'YUCHI' | 'YUWAN'

/** Integer accounting units: 100 per fish fin, one per fish ball. */
export interface DouyuGiftMoney {
  currency: DouyuGiftCurrency
  amountMinor: number
  scale: 100 | 1
}

export interface DouyuInventoryItem {
  propId: string
  name: string
  quantity: number
  propType: number | null
  isValuable: boolean | null
  expiration: { kind: 'timestamp' | 'permanent' | 'unknown'; expiresAt: number | null; dayBucket: number | null }
  rawPrice: number | null
  unitValue: DouyuGiftMoney | null
  totalValue: DouyuGiftMoney | null
  intimacyPerUnit: number | null
  intimacyTotal: number | null
  canGift: boolean
  unavailableReason: string | null
  batchSupported: boolean
}

export interface DouyuInventorySnapshot {
  accountId: string
  room: string
  checkedAt: number
  items: DouyuInventoryItem[]
  totals: {
    quantity: number
    knownValue: DouyuGiftMoney[]
    unvaluedItems: number
    knownIntimacy: number
    unknownIntimacyItems: number
  }
  message: string
}

export interface DouyuGiftCatalogItem {
  giftId: string
  name: string
  unitPrice: DouyuGiftMoney | null
  skinId: number
  available: boolean
  unavailableReason: string | null
  /** Source limit retained as metadata; zero means the catalog declares no count limit. */
  countLimit: number | null
}

export interface DouyuGiftCatalog {
  room: string
  checkedAt: number
  onceLimit: number | null
  items: DouyuGiftCatalogItem[]
}

/** Trusted main-process balance reads. Never accept these fields from IPC. */
export interface DouyuGiftBalanceRead {
  uid: string
  checkedAt: number
  balances: Record<DouyuGiftCurrency, number | null>
}

export type DouyuGiftBalanceProvider = (accountId: string, room: string, signal: AbortSignal) => Promise<DouyuGiftBalanceRead>

export interface DouyuGiftPurchase {
  accountId: string
  expectedUid: string
  room: string
  giftId: string
  quantity: number
  skinId: number
  unitPrice: DouyuGiftMoney
  expectedBalance: number
}

/** Private proof from the plan service's immediately preceding stock read. */
export interface DouyuInventoryDonation {
  accountId: string
  expectedUid: string
  room: string
  propId: string
  quantity: number
  expectedInventory: DouyuInventoryItem
}

export interface DouyuGiftReceipt {
  status: 'receipt-received' | 'not-submitted' | 'unknown'
  message: string
}

export interface DouyuInventoryGiftInput {
  room: string
  selection: 'all' | Array<{ propId: string; quantity: number }>
  intervalMs?: number
}

export interface DouyuPurchaseGiftInput {
  room: string
  giftId: string
  quantity: number
  repeat: number
  intervalMs: number
}

export interface DouyuGiftPlanRow {
  propId: string | null
  giftId: string | null
  name: string
  quantity: number
  repeat: number
  stock: number | null
  expiresAt: number | null
  unitPrice: DouyuGiftMoney | null
  total: DouyuGiftMoney | null
}

export interface DouyuGiftPlan {
  id: string
  accountId: string
  room: string
  kind: 'inventory' | 'purchase'
  createdAt: number
  expiresAt: number
  intervalMs: number
  totalQuantity: number
  totalOperations: number
  repeat: number
  budget: DouyuGiftMoney | null
  balanceBefore: DouyuGiftMoney | null
  rows: DouyuGiftPlanRow[]
  excludedItems: Array<{ propId: string; name: string; quantity: number; reason: string }>
  message: string
}

export interface DouyuGiftResultRow {
  propId: string | null
  giftId: string | null
  name: string
  quantity: number
  repetition: number
  status: 'receipt-received' | 'not-submitted' | 'unknown'
  message: string
}

export interface DouyuGiftResult {
  planId: string
  status: 'completed' | 'waiting-user' | 'cancelled' | 'failed'
  rows: DouyuGiftResultRow[]
  submittedQuantity: number
  confirmedQuantity: number
  message: string
  reason?: 'plan-changed' | 'inventory-changed' | 'balance-changed' | 'price-changed' | 'account-changed' | 'unconfirmed' | 'cancelled' | 'queue-busy' | 'unavailable'
}
