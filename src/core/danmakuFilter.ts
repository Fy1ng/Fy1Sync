/**
 * Danmaku filtering: regex blocklist + username blocklist.
 *
 * Filters are compiled once per settings change. An invalid pattern must never
 * break the overlay, so `compileDanmakuFilter` reports bad patterns instead of
 * throwing and simply ignores them while matching.
 */

export interface DanmakuFilterSettings {
  /** Regular expression sources. A message matching any of them is dropped. */
  blockedPatterns: string[]
  /** Exact (case-insensitive) usernames to drop. */
  blockedUsers: string[]
  /** Drop messages longer than this. 0 disables the check. */
  maxLength: number
}

export const DEFAULT_FILTER_SETTINGS: DanmakuFilterSettings = {
  blockedPatterns: [],
  blockedUsers: [],
  maxLength: 0,
}

export type DanmakuRejection = 'pattern' | 'user' | 'length' | 'empty'

export interface InvalidPattern {
  source: string
  message: string
}

export interface CompiledDanmakuFilter {
  /** `null` when the message passes, otherwise why it was dropped. */
  reject(message: { text: string; user: string }): DanmakuRejection | null
  invalidPatterns: InvalidPattern[]
}

export function compileDanmakuFilter(
  settings: DanmakuFilterSettings = DEFAULT_FILTER_SETTINGS,
): CompiledDanmakuFilter {
  const patterns: RegExp[] = []
  const invalidPatterns: InvalidPattern[] = []

  for (const source of settings.blockedPatterns) {
    const trimmed = source.trim()
    if (!trimmed) continue
    try {
      patterns.push(new RegExp(trimmed, 'iu'))
    } catch (error) {
      invalidPatterns.push({
        source: trimmed,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const blockedUsers = new Set(
    settings.blockedUsers.map((user) => user.trim().toLowerCase()).filter(Boolean),
  )
  const maxLength = Number.isFinite(settings.maxLength) ? Math.max(0, settings.maxLength) : 0

  return {
    invalidPatterns,
    reject(message) {
      const text = message.text.trim()
      if (!text) return 'empty'
      if (maxLength > 0 && text.length > maxLength) return 'length'
      if (blockedUsers.size > 0 && blockedUsers.has(message.user.trim().toLowerCase())) {
        return 'user'
      }
      for (const pattern of patterns) {
        pattern.lastIndex = 0
        if (pattern.test(text)) return 'pattern'
      }
      return null
    },
  }
}

/** UI copy for the debug counters in the danmaku settings panel. */
export const DANMAKU_REJECTION_TEXT: Record<DanmakuRejection, string> = {
  pattern: '命中屏蔽词',
  user: '屏蔽用户',
  length: '超出长度限制',
  empty: '空内容',
}
