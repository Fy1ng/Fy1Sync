import type { HudFieldResult, HudFrameResult } from '../core/hudWasm'
import type { RecognitionFailure, RecognitionOutcome } from '../core/types'
import type { FrameMessage } from './protocol'

/** Keep replay evidence for one uninterrupted video source, across sampling windows. */
export class HudReplaySession {
  private replay = false
  private round: number | null = null

  reset(): void {
    this.replay = false
    this.round = null
  }

  observe(result: HudFrameResult): HudFrameResult {
    const round = result.fields.round.status === 'read' ? result.fields.round.reading.value : null
    if (result.content === 'replay') {
      this.replay = true
    } else if (this.replay && round !== null && this.round !== null && round !== this.round) {
      this.replay = false
    }
    if (round !== null) this.round = round
    return this.replay ? { ...result, content: 'replay' } : result
  }
}

/** A valid countdown on a replay or unknown screen must never reach the sync estimator. */
export function hudSyncOutcome(hud: HudFrameResult, outcome: RecognitionOutcome): RecognitionOutcome {
  if (outcome.status === 'failed') return outcome
  if (hud.content === 'replay') return { status: 'indeterminate', reason: 'hud-replay' }
  if (hud.content === 'indeterminate') return { status: 'indeterminate', reason: 'hud-content-indeterminate' }
  if (hud.phase === 'statistics') return { status: 'indeterminate', reason: 'hud-statistics' }
  if (hud.phase === 'indeterminate') return { status: 'indeterminate', reason: 'hud-phase-indeterminate' }
  return outcome
}

/** The sync estimator consumes clock readings; retain the full HUD result alongside it. */
export function hudClockOutcome(hud: HudFrameResult, frame: Pick<FrameMessage, 'mediaTime' | 'wallTime' | 'frameIndex'>): RecognitionOutcome {
  return hudSyncOutcome(hud, clockOutcome(hud.fields.clock, frame))
}

function clockOutcome(result: HudFieldResult, frame: Pick<FrameMessage, 'mediaTime' | 'wallTime' | 'frameIndex'>): RecognitionOutcome {
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

