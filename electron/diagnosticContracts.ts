/** Public diagnostics contain only bounded counters, fixed classifications and public versions. */
export const DIAGNOSTIC_LIMITS = { maxAttempts: 20, maxEventsPerAttempt: 64 } as const
export const DIAGNOSTIC_STAGES = ['resolve', 'route', 'provider', 'hls', 'adaptive', 'hls-fallback', 'huya', 'buffer', 'complete'] as const
export const DIAGNOSTIC_STATUSES = ['started', 'available', 'unavailable', 'prepared', 'resolved', 'failed', 'skipped', 'cancelled'] as const
export const DIAGNOSTIC_WARNINGS = ['authentication', 'token-provider', 'javascript-runtime', 'network', 'formats-unavailable', 'runtime-dependency'] as const
export const DIAGNOSTIC_CODES = [
  'unsupported-url', 'not-live', 'room-not-found', 'upstream-error', 'restricted', 'needs-manual-url',
  'bot-check', 'sign-in', 'members-only', 'age-restricted', 'geo-restricted', 'private',
  'youtube-formats-empty', 'youtube-hls-separated', 'youtube-hls-unsupported', 'youtube-hls-missing',
  'tool-missing', 'tool-invalid-path', 'tool-not-executable', 'provider-prepare-failed',
  'extractor-failed', 'invalid-metadata', 'spawn-failed', 'runtime-unavailable', 'timeout', 'output-limit',
  'proxy-resolution-failed', 'proxy-unreachable', 'proxy-rejected', 'proxy-failed',
  'proxy-type-unsupported', 'socks4-unsupported',
  'dns-failed', 'connection-refused', 'connection-timeout', 'connection-failed', 'tls-certificate', 'tls-failed',
  'source-resolve-failed', 'first-video-timeout', 'playback-not-ready', 'buffer-failed', 'upstream-stalled', 'policy-rejected',
  'upstream-request-failed', 'media-format-invalid', 'media-codec-unsupported', 'credentials-cross-origin', 'media-network-boundary',
  'adaptive-expired', 'adaptive-request-failed', 'adaptive-invalid-head', 'adaptive-unsafe-url',
  'adaptive-segment-too-large', 'adaptive-pipe-failed', 'adaptive-aborted',
  'invalid-url', 'host-not-allowed', 'port-not-allowed', 'private-address', 'redirect-limit',
  'cancelled', 'unknown',
] as const
export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number] | `http-${number}`
export interface DiagnosticFormatSummary {
  total: number
  protocols: { hls: number; https: number; dash: number; other: number }
  videoCodecs: { h264: number; vp9: number; av1: number; none: number; other: number }
  audioCodecs: { aac: number; opus: number; none: number; other: number }
  muxedHls: number
  adaptivePairs: number
}
export interface DiagnosticEvent {
  at: number
  stage: typeof DIAGNOSTIC_STAGES[number]
  status: typeof DIAGNOSTIC_STATUSES[number]
  extractionId?: number
  client?: 'default' | 'web' | 'web_safari' | 'huya'
  route?: 'direct' | 'http' | 'socks5' | 'unsupported' | 'unknown'
  routeReason?: 'socks4-unsupported' | 'proxy-type-unsupported' | 'proxy-resolution-failed'
  code?: DiagnosticCode
  exitCode?: number | null
  stopped?: boolean
  stopReason?: 'timeout' | 'output-limit' | 'cancelled'
  warnings?: typeof DIAGNOSTIC_WARNINGS[number][]
  heights?: number[]
  adaptiveHeights?: number[]
  formats?: DiagnosticFormatSummary
  providerConfigured?: boolean
  providerOutcome?: 'token-observed' | 'warning' | 'unconfirmed' | 'not-requested'
  adaptive?: boolean
}
export interface DiagnosticAttempt {
  id: number
  startedAt: number
  endedAt: number | null
  role: 'official' | 'commentary' | 'extra'
  operation: 'open' | 'reconnect' | 'hls-recovery'
  status: 'running' | 'resolved' | 'failed' | 'cancelled'
  droppedEvents: number
  events: DiagnosticEvent[]
}
/** Internal observer. Unknown input is normalized before it can enter the ring buffer. */
export interface DiagnosticAttemptSink {
  record(event: unknown): void
  finish(status: Exclude<DiagnosticAttempt['status'], 'running'>, event?: unknown): void
}
export interface AcquisitionDiagnosticRecorder {
  begin(role: unknown, operation?: DiagnosticAttempt['operation']): DiagnosticAttemptSink
}
export interface AcquisitionDiagnosticReport {
  schemaVersion: 1
  generatedAt: number
  app: {
    version: string | null
    electron: string | null
    node: string | null
    platform: 'win32' | 'darwin' | 'linux' | 'unknown'
    arch: 'x64' | 'arm64' | 'ia32' | 'arm' | 'unknown'
    packaged: boolean
  }
  tools: {
    status: 'ok' | 'unavailable'
    items: { name: 'ffmpeg' | 'ffprobe' | 'yt-dlp'; available: boolean; source: 'external' | 'managed' | 'bundled' | 'PATH' | 'unknown'; version: string | null }[]
    provider: { available: boolean | null; source: 'external' | 'bundled' | 'none' | 'unknown'; version: string | null }
  }
  login: { youtube: boolean | null; douyu: boolean | null }
  attempts: DiagnosticAttempt[]
  droppedAttempts: number
  limits: typeof DIAGNOSTIC_LIMITS
}
export interface AcquisitionDiagnosticsService { report(): Promise<AcquisitionDiagnosticReport> }
