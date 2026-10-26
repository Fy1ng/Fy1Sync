/**
 * Display helpers for statistics. Every helper takes `null` for "the platform did not say"
 * and renders it as 未知 — a missing value is never shown as zero.
 */

export const UNKNOWN = '未知'

const valid = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

/** Wall-clock time, minute precision; the date is included because statistics span days. */
export function formatTime(ms: number | null | undefined): string {
  if (!valid(ms)) return UNKNOWN
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return UNKNOWN
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!valid(seconds) || seconds < 0) return UNKNOWN
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

export function formatCount(value: number | null | undefined): string {
  return valid(value) ? value.toLocaleString('zh-CN') : UNKNOWN
}

/** Minor units at a fixed scale of 100 (fen, or Douyu's 鱼翅 catalog scale), two decimals. */
export function formatMinor(minor: number | null | undefined): string {
  if (!valid(minor)) return UNKNOWN
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
