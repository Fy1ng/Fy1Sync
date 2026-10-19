import { describe, expect, it } from 'vitest'
import { anchoredScrollTop, chatWindow, CHAT_OVERSCAN, CHAT_ROW_HEIGHT, isPinned } from './chatWindow'

describe('chat windowing', () => {
  it('renders only the visible rows plus overscan, however long the history', () => {
    for (const count of [50, 2000, 200_000]) {
      const top = Math.floor(count / 2) * CHAT_ROW_HEIGHT
      const { start, end, height } = chatWindow(count, top, 260)
      expect(height).toBe(count * CHAT_ROW_HEIGHT)
      expect(end - start).toBeLessThanOrEqual(Math.ceil(260 / CHAT_ROW_HEIGHT) + 1 + CHAT_OVERSCAN * 2)
      expect(start).toBeLessThanOrEqual(Math.floor(top / CHAT_ROW_HEIGHT))
    }
  })

  it('clamps at both ends', () => {
    expect(chatWindow(3, 0, 260)).toEqual({ start: 0, end: 3, height: 3 * CHAT_ROW_HEIGHT })
    const tail = chatWindow(100, 100 * CHAT_ROW_HEIGHT, 260)
    expect(tail.end).toBe(100)
    expect(chatWindow(0, 0, 260)).toEqual({ start: 0, end: 0, height: 0 })
  })

  it('treats near-bottom as pinned', () => {
    expect(isPinned(1000 - 260, 260, 1000)).toBe(true)
    expect(isPinned(1000 - 260 - 10, 260, 1000)).toBe(true)
    expect(isPinned(100, 260, 1000)).toBe(false)
  })

  it('follows the bottom when pinned and holds the reader still otherwise', () => {
    expect(anchoredScrollTop({ pinned: true, scrollTop: 0, viewport: 260, height: 5200, droppedFromFront: 0 })).toBe(4940)
    // Rows trimmed from the front shift everything up; the reader moves with them.
    expect(anchoredScrollTop({ pinned: false, scrollTop: 1300, viewport: 260, height: 5200, droppedFromFront: 10 })).toBe(1300 - 10 * CHAT_ROW_HEIGHT)
    expect(anchoredScrollTop({ pinned: false, scrollTop: 50, viewport: 260, height: 5200, droppedFromFront: 10 })).toBe(0)
  })
})
