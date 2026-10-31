import type { HudFieldResult } from '../core/hudWasm'
import type { RecognitionFailure, RecognitionOutcome } from '../core/types'
import type { FrameMessage } from './protocol'

/** The sync estimator consumes clock readings; retain the full HUD result alongside it. */
export function hudClockOutcome(result: HudFieldResult, frame: Pick<FrameMessage, 'mediaTime' | 'wallTime' | 'frameIndex'>): RecognitionOutcome {
  if (result.status === 'read') {
    return { status: 'success', reading: { ...result.reading, seconds: result.reading.value,
      mediaTime: frame.mediaTime, wallTime: frame.wallTime, frameIndex: frame.frameIndex } }
  }
  if (result.status === 'absent') return { status: 'absent' }
  if (result.status === 'indeterminate') return { status: 'indeterminate', reason: result.reason }
  const reasons: RecognitionFailure[] = ['no-profile', 'insufficient-templates', 'blank-frame', 'no-candidates', 'low-confidence', 'invalid-format', 'decode-failed']
  const reason = result.reason
  return { status: 'failed', reason: reasons.includes(reason as RecognitionFailure) ? reason as RecognitionFailure : 'no-candidates', detail: reason }
}

