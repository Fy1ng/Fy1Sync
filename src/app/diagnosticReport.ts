import { sanitizeDiagnosticReport } from '../../electron/diagnosticSanitizer'

const BUFFER_STATES = new Set(['starting', 'buffering', 'ready', 'stalled', 'reconnecting', 'failed', 'stopped'])
const STALL_CATEGORIES = new Set(['production', 'fetch', 'playback', 'thread', 'unknown'])
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown, maximum = 1_000_000_000_000): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : null
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null

/** Feedback needs a compact playback summary, never source descriptors or raw player errors. */
function playbackRole(value: unknown) {
  const role = object(value)
  const samples = Array.isArray(role.samples) ? role.samples : []
  const raw = samples.at(-1)
  const latest = object(raw)
  const localBuffer = object(latest.localBuffer)
  const stall = object(role.lastStall)
  return {
    sampleCount: Math.min(samples.length, 1_000_000),
    latest: raw && typeof raw === 'object' && !Array.isArray(raw) ? {
      at: number(latest.at, Number.MAX_SAFE_INTEGER),
      currentTime: number(latest.currentTime),
      readyState: typeof latest.readyState === 'number' && Number.isInteger(latest.readyState)
        && latest.readyState >= 0 && latest.readyState <= 4 ? latest.readyState : null,
      paused: boolean(latest.paused),
      seeking: boolean(latest.seeking),
      bufferAhead: number(latest.bufferAhead),
      droppedFramesDelta: number(latest.droppedFramesDelta),
      timerLateMs: number(latest.timerLateMs),
      localBuffer: latest.localBuffer && typeof latest.localBuffer === 'object' && !Array.isArray(latest.localBuffer) ? {
        state: typeof localBuffer.state === 'string' && BUFFER_STATES.has(localBuffer.state) ? localBuffer.state : 'unknown',
        seconds: number(localBuffer.seconds),
        completeSegments: number(localBuffer.completeSegments, 1_000_000),
      } : null,
    } : null,
    lastStall: role.lastStall && typeof role.lastStall === 'object' && !Array.isArray(role.lastStall) ? {
      durationMs: number(stall.durationMs),
      category: typeof stall.category === 'string' && STALL_CATEGORIES.has(stall.category) ? stall.category : 'unknown',
      ongoing: boolean(stall.ongoing),
    } : null,
  }
}

/** Rebuild both halves explicitly so unrelated state cannot enter the downloaded artifact. */
export function createFeedbackReport(acquisition: unknown, playback: unknown) {
  const source = object(playback)
  return {
    schemaVersion: 1 as const,
    acquisition: sanitizeDiagnosticReport(acquisition),
    playback: { official: playbackRole(source.official), commentary: playbackRole(source.commentary) },
  }
}
