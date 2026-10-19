/**
 * Pure windowing math for the chat list, testable without layout.
 *
 * Rows have a fixed height. Chat lines are one line by design (long ones are truncated
 * with an ellipsis and shown whole in the title), which is what makes windowing exact:
 * no measurement pass, no jumping when a row's height turns out different from a guess.
 */

export const CHAT_ROW_HEIGHT = 26
export const CHAT_OVERSCAN = 6

export interface ChatWindow {
  /** Index of the first rendered row. */
  start: number
  /** One past the last rendered row. */
  end: number
  /** Total scrollable height, px. */
  height: number
}

export function chatWindow(count: number, scrollTop: number, viewport: number, row = CHAT_ROW_HEIGHT, overscan = CHAT_OVERSCAN): ChatWindow {
  const height = count * row
  if (count === 0 || viewport <= 0) return { start: 0, end: Math.min(count, overscan), height }
  const first = Math.floor(Math.max(0, scrollTop) / row)
  const visible = Math.ceil(viewport / row) + 1
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + visible + overscan)
  return { start, end, height }
}

/** Close enough to the bottom that new messages should keep it there. */
export function isPinned(scrollTop: number, viewport: number, height: number, slack = CHAT_ROW_HEIGHT): boolean {
  return height - (scrollTop + viewport) <= slack
}

/**
 * Where to scroll after the history changed underneath the user.
 *
 * The history is bounded, so old rows drop off the front while new ones arrive at the back.
 * A user reading scrolled-up must keep seeing the same message: shift by the rows removed
 * from the front. A pinned user follows the bottom.
 */
export function anchoredScrollTop(options: {
  pinned: boolean
  scrollTop: number
  viewport: number
  height: number
  droppedFromFront: number
  row?: number
}): number {
  const row = options.row ?? CHAT_ROW_HEIGHT
  if (options.pinned) return Math.max(0, options.height - options.viewport)
  return Math.max(0, options.scrollTop - options.droppedFromFront * row)
}
