/**
 * Teaching a whole countdown reading at once.
 *
 * Instead of picking each glyph box and pressing its character, the reading is typed whole
 * (`1:23`) and its characters are paired with the boxes left to right. A reading that does
 * not have one character per box is refused, never stretched to fit: a mismatch means the
 * boxes are wrong (two digits merged, a colon split) and samples from it would be wrong too.
 */

import { CLOCK_CHARS, type ClockChar } from '../../core/profileSchema'

const CHARS = new Set<string>(CLOCK_CHARS)

export type ReadingPairs =
  | { ok: true; chars: ClockChar[] }
  | { ok: false; reason: string }

/** Pair `text` with `boxCount` boxes, left to right; whitespace is ignored. */
export function pairReading(text: string, boxCount: number): ReadingPairs {
  const chars = [...text.replace(/\s+/g, '')]
  if (chars.length === 0) return { ok: false, reason: '输入这一帧的完整读数，例如 1:23' }
  const bad = chars.find((char) => !CHARS.has(char))
  if (bad !== undefined) return { ok: false, reason: `「${bad}」不是倒计时里的字符，只能用数字和冒号` }
  if (boxCount === 0) return { ok: false, reason: '没有切出字符框，先调整识别区域或阈值' }
  if (chars.length !== boxCount) {
    return { ok: false, reason: `读数有 ${chars.length} 个字符，切出了 ${boxCount} 个字符框，先合并、拆分或排除字符框让两者一致` }
  }
  return { ok: true, chars: chars as ClockChar[] }
}

/** `m:ss` text for a countdown of `seconds`, the way the HUD draws it. */
export function clockText(seconds: number, format: 'm:ss' | 'mm:ss' | 'ss'): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (format === 'ss') return String(whole)
  const minutes = Math.floor(whole / 60)
  const rest = String(whole % 60).padStart(2, '0')
  return `${format === 'mm:ss' ? String(minutes).padStart(2, '0') : minutes}:${rest}`
}
