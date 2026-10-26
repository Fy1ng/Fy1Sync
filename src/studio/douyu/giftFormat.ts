/**
 * Display rules shared by the backpack, gifting and badge views. The point of keeping them
 * in one place is that "unknown" is spelled the same everywhere and is never quietly turned
 * into zero, "permanent" or a currency the platform does not use.
 */

import type { DouyuGiftMoney, DouyuInventoryItem } from '../../../server/douyu/inventoryTypes'

export const UNKNOWN = '未知'
const UNIT = { YUCHI: '鱼翅', YUWAN: '鱼丸' } as const
const SCALE = { YUCHI: 100, YUWAN: 1 } as const

/** Only a money value whose scale matches its currency is trusted for display. */
export function validMoney(value: DouyuGiftMoney | null | undefined): value is DouyuGiftMoney {
  return !!value && (value.currency === 'YUCHI' || value.currency === 'YUWAN')
    && value.scale === SCALE[value.currency] && Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0
}

/** 1050 YUCHI minor units read "10.5 鱼翅"; never a cash amount. */
export function money(value: DouyuGiftMoney | null | undefined): string {
  if (!validMoney(value)) return UNKNOWN
  const amount = value.amountMinor / value.scale
  return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${UNIT[value.currency]}`
}

/** The accounting behind a displayed amount, for confirmation pages. */
export function moneyBasis(value: DouyuGiftMoney | null | undefined): string {
  return validMoney(value) ? `${value.currency}，scale ${value.scale}，计价值 ${value.amountMinor}` : ''
}

export function dateTime(value: number | null | undefined): string {
  if (typeof value !== 'number') return UNKNOWN
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : UNKNOWN
}

export function dateOnly(value: number | null | undefined): string {
  if (typeof value !== 'number') return UNKNOWN
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN') : UNKNOWN
}

/** `unknown` stays unknown; only an explicit `permanent` reads 永久. */
export function expiry(expiration: DouyuInventoryItem['expiration'] | null | undefined): string {
  if (expiration?.kind === 'permanent') return '永久'
  if (expiration?.kind === 'timestamp' && typeof expiration.expiresAt === 'number') return dateTime(expiration.expiresAt)
  return UNKNOWN
}

/** A whole number in [min, max] typed into a field, or null. */
export function wholeIn(text: string, min: number, max: number): number | null {
  if (text.trim() === '' || !/^\d+$/.test(text.trim())) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

export const roomOk = (text: string): boolean => /^[1-9][0-9]{0,11}$/.test(text)

export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}
