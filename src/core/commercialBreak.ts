import type { BufferCommercialBreak } from '../../electron/bufferManager'
import { seekableRange } from './syncPlan'
import type { Timebase } from './types'

export const TWITCH_COMMERCIAL_BREAK_NOTICE =
  'Commercial Break为Twitch官方广告时段, 通常持续15~30s后自动恢复直播, 请勿重新载入'

export const TWITCH_COMMERCIAL_BREAK_BADGE = 'Twitch 广告时段'

/**
 * Determine whether the viewer's current playback position on a Twitch source falls
 * inside a stitched commercial break.
 *
 * Matching against the published buffer's `[start, end]` segment ranges keeps the notice
 * aligned with rewound playback (e.g. when Twitch is delayed 25 s to match commentary):
 * it neither appears early before the playhead reaches the slate nor disappears early
 * when upstream resumes while the rewound playhead is still inside the slate.
 */
export function isCommercialBreakActive(options: {
  platform?: string | null
  status?: 'empty' | 'loading' | 'ready' | 'error'
  commercialBreak?: BufferCommercialBreak | null
  bufferSeconds?: number
  currentTime?: number
  timebase?: Timebase | null
}): boolean {
  const { platform, status, commercialBreak, bufferSeconds, currentTime, timebase } = options
  if (platform !== 'twitch' || !commercialBreak || status === 'empty' || status === 'error') return false

  if (!timebase || typeof currentTime !== 'number' || !Number.isFinite(currentTime)) {
    return commercialBreak.live
  }

  const range = seekableRange(timebase)
  if (range.end - range.start <= 0.05) return commercialBreak.live

  const windowStart = typeof bufferSeconds === 'number' && Number.isFinite(bufferSeconds) && bufferSeconds > 0
    ? Math.max(range.start, range.end - bufferSeconds)
    : range.start
  const offset = Math.max(0, currentTime - windowStart)

  for (let index = 0; index < commercialBreak.ranges.length; index += 1) {
    const [start, end] = commercialBreak.ranges[index]!
    const ongoingTail = commercialBreak.live && index === commercialBreak.ranges.length - 1
    if (offset >= start - 0.35 && (ongoingTail ? offset <= end + 4 : offset <= end + 0.35)) {
      return true
    }
  }
  return false
}
