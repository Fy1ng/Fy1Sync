/**
 * Pure logic behind the manual offset buttons, kept out of the component so it can be
 * tested without a DOM.
 *
 * Direction follows the sync design: a positive offset rewinds the official source, a
 * negative one rewinds the commentary. The buttons are named for what the user sees move:
 * ◀ sends the official picture back (offset grows), ▶ sends the commentary back (offset
 * shrinks). Nothing ever plays forward; live media can only go back.
 */

import { MAX_OFFSET_SECONDS } from '../../core/types'

export type NudgeDirection = 'official' | 'commentary'

export const SMALL_STEP_BOUNDS = { min: 0.05, max: 2 } as const
export const LARGE_STEP_BOUNDS = { min: 1, max: 30 } as const

/** Round to the millisecond so repeated 0.05 s steps do not collect float residue. */
export function roundOffset(value: number): number {
  // `+ 0` folds -0 into 0, which would otherwise print as "−0.00".
  return Math.round(value * 1000) / 1000 + 0
}

export function clampManualOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return roundOffset(Math.min(MAX_OFFSET_SECONDS, Math.max(-MAX_OFFSET_SECONDS, value)))
}

/** Offset after one press. */
export function nudgedOffset(current: number, direction: NudgeDirection, step: number): number {
  const delta = direction === 'official' ? step : -step
  return clampManualOffset(current + delta)
}

/** True when another press in this direction would change nothing. */
export function atLimit(current: number, direction: NudgeDirection): boolean {
  return direction === 'official' ? current >= MAX_OFFSET_SECONDS : current <= -MAX_OFFSET_SECONDS
}

export type ParsedOffset = { ok: true; value: number } | { ok: false; message: string }

/**
 * Parse what the user typed into the readout. Accepts `5`, `+5`, `-2.35`, `−2.35` (the
 * typographic minus the readout itself shows), an optional trailing `s`/`秒`, and a comma
 * decimal separator.
 */
export function parseOffsetInput(text: string): ParsedOffset {
  const normalized = text
    .trim()
    .replace(/[−–]/g, '-')
    .replace(/[，,]/g, '.')
    .replace(/\s*(s|秒)$/i, '')
  if (normalized === '') return { ok: false, message: '请输入偏移秒数' }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return { ok: false, message: '只能输入数字，例如 -2.5' }
  const value = Number(normalized)
  if (!Number.isFinite(value)) return { ok: false, message: '只能输入数字，例如 -2.5' }
  if (Math.abs(value) > MAX_OFFSET_SECONDS) {
    return { ok: false, message: `偏移范围是 ±${MAX_OFFSET_SECONDS} 秒` }
  }
  return { ok: true, value: roundOffset(value) }
}

/** Readout text: always signed, two decimals, with a real minus sign. */
export function formatOffset(value: number): string {
  const rounded = roundOffset(value)
  if (rounded === 0) return '0.00'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}`
}

/** Step label on a button: `0.5s`, `5s`, `0.05s` — no trailing zeros. */
export function formatStep(step: number): string {
  return `${Number(step.toFixed(3))}s`
}

/**
 * Delay before the n-th automatic repeat while a button is held (n starts at 1).
 * The first repeat waits long enough that a normal click never repeats; after that the
 * rate climbs so crossing tens of seconds does not take tens of presses.
 */
export function repeatDelay(n: number): number {
  if (n <= 1) return 420
  if (n <= 4) return 160
  if (n <= 10) return 90
  return 50
}

/** Settings-side validation; the large step can never be smaller than the small one. */
export function normalizeSteps(small: unknown, large: unknown, fallback: { small: number; large: number }): {
  small: number
  large: number
} {
  const pick = (value: unknown, bounds: { min: number; max: number }, otherwise: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? roundOffset(Math.min(bounds.max, Math.max(bounds.min, value)))
      : otherwise
  const nextSmall = pick(small, SMALL_STEP_BOUNDS, fallback.small)
  const nextLarge = Math.max(nextSmall, pick(large, LARGE_STEP_BOUNDS, fallback.large))
  return { small: nextSmall, large: nextLarge }
}

/**
 * Keyboard shortcuts, active while focus is not in a text field:
 *   [ / ]           small step  (◀ official back / commentary back ▶)
 *   Shift+[ / ]     large step
 *   \               back to zero
 * Brackets because they sit together, carry no browser or media meaning, and point the
 * same way as the buttons.
 */
export type ShortcutAction = { kind: 'nudge'; direction: NudgeDirection; size: 'small' | 'large' } | { kind: 'reset' }

export function shortcutFor(event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): ShortcutAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  const size = event.shiftKey ? 'large' : 'small'
  if (event.code === 'BracketLeft') return { kind: 'nudge', direction: 'official', size }
  if (event.code === 'BracketRight') return { kind: 'nudge', direction: 'commentary', size }
  if (event.code === 'Backslash' && !event.shiftKey) return { kind: 'reset' }
  return null
}

/** Typing in a field, or operating a menu, must never move the playhead. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="listbox"]')) return true
  return false
}
