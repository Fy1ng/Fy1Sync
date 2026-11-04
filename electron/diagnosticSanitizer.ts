import {
  DIAGNOSTIC_CODES, DIAGNOSTIC_LIMITS, DIAGNOSTIC_STAGES, DIAGNOSTIC_STATUSES, DIAGNOSTIC_WARNINGS,
  type AcquisitionDiagnosticReport, type DiagnosticAttempt, type DiagnosticCode, type DiagnosticEvent, type DiagnosticFormatSummary,
} from './diagnosticContracts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const choice = <T extends string>(value: unknown, values: readonly T[]): T | undefined =>
  typeof value === 'string' && values.includes(value as T) ? value as T : undefined
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined
const count = (value: unknown): number => integer(value, 1_000_000) ?? 0
const timestamp = (value: unknown): number => integer(value, 8_640_000_000_000_000) ?? 0
const nullableBoolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
const version = (value: unknown): string | null => typeof value === 'string' && /^(?:[vVnN]-?)?\d[A-Za-z0-9.+_-]{0,97}$/.test(value) ? value : null

export function diagnosticCode(value: unknown): DiagnosticCode {
  return choice(value, DIAGNOSTIC_CODES) ?? (typeof value === 'string' && /^http-[45]\d{2}$/.test(value) ? value as DiagnosticCode : 'unknown')
}

function formatSummary(value: unknown): DiagnosticFormatSummary {
  const raw = object(value), protocols = object(raw.protocols), video = object(raw.videoCodecs), audio = object(raw.audioCodecs)
  return {
    total: count(raw.total),
    protocols: { hls: count(protocols.hls), https: count(protocols.https), dash: count(protocols.dash), other: count(protocols.other) },
    videoCodecs: { h264: count(video.h264), vp9: count(video.vp9), av1: count(video.av1), none: count(video.none), other: count(video.other) },
    audioCodecs: { aac: count(audio.aac), opus: count(audio.opus), none: count(audio.none), other: count(audio.other) },
    muxedHls: count(raw.muxedHls), adaptivePairs: count(raw.adaptivePairs),
  }
}

/** Normalize before retention, not after collecting arbitrary upstream objects. */
export function sanitizeDiagnosticEvent(value: unknown, at: number): DiagnosticEvent | null {
  const raw = object(value)
  const stage = choice(raw.stage, DIAGNOSTIC_STAGES), status = choice(raw.status, DIAGNOSTIC_STATUSES)
  if (!stage || !status) return null
  const event: DiagnosticEvent = { at: timestamp(at), stage, status }
  const extractionId = integer(raw.extractionId)
  if (extractionId !== undefined) event.extractionId = extractionId
  const client = choice(raw.client, ['default', 'web', 'web_safari', 'huya'] as const)
  if (client) event.client = client
  const route = choice(raw.route, ['direct', 'http', 'socks5', 'unsupported', 'unknown'] as const)
  if (route) event.route = route
  const routeReason = choice(raw.routeReason, ['socks4-unsupported', 'proxy-type-unsupported', 'proxy-resolution-failed'] as const)
  if (routeReason) event.routeReason = routeReason
  if (raw.code !== undefined) event.code = diagnosticCode(raw.code)
  if (raw.exitCode === null) event.exitCode = null
  else if (typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode) && Math.abs(raw.exitCode) <= 4_294_967_295) event.exitCode = raw.exitCode
  if (typeof raw.stopped === 'boolean') event.stopped = raw.stopped
  const stopReason = choice(raw.stopReason, ['timeout', 'output-limit', 'cancelled'] as const)
  if (stopReason) event.stopReason = stopReason
  if (Array.isArray(raw.warnings)) event.warnings = [...new Set(raw.warnings.flatMap(value => choice(value, DIAGNOSTIC_WARNINGS) ?? []))].slice(0, DIAGNOSTIC_WARNINGS.length)
  for (const key of ['heights', 'adaptiveHeights'] as const) {
    if (Array.isArray(raw[key])) event[key] = [...new Set(raw[key].filter((value): value is number => integer(value, 16384) !== undefined && Number(value) > 0))].sort((a, b) => b - a).slice(0, 32)
  }
  if (raw.formats !== undefined) event.formats = formatSummary(raw.formats)
  if (typeof raw.providerConfigured === 'boolean') event.providerConfigured = raw.providerConfigured
  const outcome = choice(raw.providerOutcome, ['token-observed', 'warning', 'unconfirmed', 'not-requested'] as const)
  if (outcome) event.providerOutcome = outcome
  if (typeof raw.adaptive === 'boolean') event.adaptive = raw.adaptive
  return event
}

/** A second field whitelist protects the export boundary, including unexpected runtime values. */
export function sanitizeDiagnosticReport(value: unknown): AcquisitionDiagnosticReport {
  const raw = object(value), app = object(raw.app), tools = object(raw.tools), provider = object(tools.provider), login = object(raw.login)
  const items = Array.isArray(tools.items) ? tools.items.map(object) : []
  const attempts = Array.isArray(raw.attempts) ? raw.attempts.slice(-DIAGNOSTIC_LIMITS.maxAttempts).map((value): DiagnosticAttempt | null => {
    const attempt = object(value), id = integer(attempt.id)
    if (id === undefined) return null
    const events = Array.isArray(attempt.events) ? attempt.events.slice(-DIAGNOSTIC_LIMITS.maxEventsPerAttempt)
      .map(value => sanitizeDiagnosticEvent(value, timestamp(object(value).at))).filter((value): value is DiagnosticEvent => value !== null) : []
    return { id, startedAt: timestamp(attempt.startedAt), endedAt: attempt.endedAt === null ? null : timestamp(attempt.endedAt),
      role: choice(attempt.role, ['official', 'commentary', 'extra'] as const) ?? 'extra',
      operation: choice(attempt.operation, ['open', 'reconnect', 'hls-recovery'] as const) ?? 'open',
      status: choice(attempt.status, ['running', 'resolved', 'failed', 'cancelled'] as const) ?? 'failed',
      droppedEvents: count(attempt.droppedEvents), events }
  }).filter((value): value is DiagnosticAttempt => value !== null) : []
  return {
    schemaVersion: 1, generatedAt: timestamp(raw.generatedAt),
    app: { version: version(app.version), electron: version(app.electron), node: version(app.node), packaged: app.packaged === true,
      platform: choice(app.platform, ['win32', 'darwin', 'linux'] as const) ?? 'unknown',
      arch: choice(app.arch, ['x64', 'arm64', 'ia32', 'arm'] as const) ?? 'unknown' },
    tools: {
      status: tools.status === 'ok' ? 'ok' : 'unavailable',
      items: (['ffmpeg', 'ffprobe', 'yt-dlp'] as const).map(name => {
        const item = items.find(item => item.name === name) ?? {}
        return { name, available: item.available === true, source: choice(item.source, ['external', 'managed', 'bundled', 'PATH'] as const) ?? 'unknown', version: version(item.version) }
      }),
      provider: { available: nullableBoolean(provider.available), source: choice(provider.source, ['external', 'bundled', 'none'] as const) ?? 'unknown', version: version(provider.version) },
    },
    login: { youtube: nullableBoolean(login.youtube), douyu: nullableBoolean(login.douyu) },
    attempts, droppedAttempts: count(raw.droppedAttempts), limits: { ...DIAGNOSTIC_LIMITS },
  }
}
