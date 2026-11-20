export const SECONDS_INPUT_ERROR = '请输入 0 至 60 秒，最多 3 位小数。'

export function parseSecondsToMs(text: string): number | null {
  const value = text.trim()
  if (!/^(?:\d+|\d*\.\d{1,3})$/.test(value)) return null
  const seconds = Number(value)
  return seconds <= 60 ? Math.round(seconds * 1_000) : null
}

export function formatMsAsSeconds(milliseconds: number): string {
  return String(milliseconds / 1_000)
}
