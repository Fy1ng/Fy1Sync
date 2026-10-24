export interface DouyuRenewalTarget {
  room: string
  badgeName: string
}

export interface DouyuRenewalTargetPage {
  accountId: string
  checkedAt: number
  coverage: 'returned-page' | 'official-snapshot' | 'all-pages'
  pageCount?: number
  targets: DouyuRenewalTarget[]
  message: string
}

/** Explicit per-room quantities override the preview's default only for selected rooms. */
export interface DouyuRenewalQuantity {
  room: string
  quantity: number
}

export interface DouyuRenewalGift {
  propId: string
  name: string
  quantity: number
  stock: number
  expiresAt: number | null
}

export interface DouyuRenewalPlanRow extends DouyuRenewalTarget {
  status: 'ready' | 'skipped'
  gift: DouyuRenewalGift | null
  reason: string | null
}

export interface DouyuRenewalPlan {
  id: string
  accountId: string
  createdAt: number
  expiresAt: number
  rows: DouyuRenewalPlanRow[]
  totalQuantity: number
  message: string
}

export interface DouyuRenewalResultRow extends DouyuRenewalTarget {
  propName: string | null
  quantity: number
  status: 'receipt-received' | 'skipped' | 'not-submitted' | 'unknown'
  message: string
}

export interface DouyuRenewalResult {
  planId: string
  status: 'completed' | 'waiting-user' | 'cancelled' | 'failed'
  rows: DouyuRenewalResultRow[]
  message: string
  reason?: 'plan-changed' | 'inventory-changed' | 'account-changed' | 'unconfirmed' | 'cancelled' | 'queue-busy' | 'unavailable'
}

/** Private main-process metadata; never serialize the whole object to the renderer. */
export interface DouyuBackpackItem {
  id: string
  name: string
  count: number
  met: number | null
  propType: number | null
  isClick: number | null
  isValuable: boolean | null
  eligible: boolean
  reason: string | null
}

export interface DouyuBackpackRead {
  uid: string
  payload: unknown
}

export interface DouyuBadgePageRead {
  uid: string
  html: string
}

export interface DouyuBackpackDonation {
  accountId: string
  expectedUid: string
  room: string
  propId: string
  quantity: number
}

export interface DouyuBackpackReceipt {
  status: 'receipt-received' | 'not-submitted' | 'unknown'
  message: string
}
