import {
  DIAGNOSTIC_LIMITS, type AcquisitionDiagnosticRecorder, type AcquisitionDiagnosticReport, type AcquisitionDiagnosticsService,
  type DiagnosticAttempt, type DiagnosticAttemptSink,
} from './diagnosticContracts'
import { sanitizeDiagnosticEvent, sanitizeDiagnosticReport } from './diagnosticSanitizer'
import type { ToolsService } from './toolsService'
import type { LoginStatus } from './cookies'

export class AcquisitionDiagnostics implements AcquisitionDiagnosticRecorder, AcquisitionDiagnosticsService {
  private sequence = 0
  private droppedAttempts = 0
  private readonly attempts: DiagnosticAttempt[] = []
  private readonly now: () => number
  private flight?: Promise<AcquisitionDiagnosticReport>
  constructor(private readonly options: {
    app: AcquisitionDiagnosticReport['app']
    tools: Pick<ToolsService, 'status'>
    loginStatus: () => Promise<LoginStatus>
    now?: () => number
  }) { this.now = options.now ?? Date.now }

  begin(role: unknown, operation: DiagnosticAttempt['operation'] = 'open'): DiagnosticAttemptSink {
    const attempt: DiagnosticAttempt = { id: ++this.sequence, startedAt: this.now(), endedAt: null,
      role: role === 'official' || role === 'commentary' ? role : 'extra', operation, status: 'running', droppedEvents: 0, events: [] }
    this.attempts.push(attempt)
    if (this.attempts.length > DIAGNOSTIC_LIMITS.maxAttempts) { this.attempts.shift(); this.droppedAttempts++ }
    const record = (value: unknown) => {
      if (attempt.endedAt !== null || !this.attempts.includes(attempt)) return
      const event = sanitizeDiagnosticEvent(value, this.now())
      if (!event) return
      attempt.events.push(event)
      if (attempt.events.length > DIAGNOSTIC_LIMITS.maxEventsPerAttempt) { attempt.events.shift(); attempt.droppedEvents++ }
    }
    record({ stage: 'resolve', status: 'started' })
    return { record, finish: (status, event) => {
      if (attempt.endedAt !== null || !this.attempts.includes(attempt)) return
      record(event)
      record({ stage: 'complete', status: status === 'resolved' ? 'resolved' : status === 'cancelled' ? 'cancelled' : 'failed' })
      attempt.status = status
      attempt.endedAt = this.now()
    } }
  }

  /** Report creation reads local version/login metadata; it never opens an upstream stream. */
  report(): Promise<AcquisitionDiagnosticReport> {
    if (this.flight) return this.flight.then(value => structuredClone(value))
    const work = this.createReport().finally(() => { if (this.flight === work) this.flight = undefined })
    this.flight = work
    return work.then(value => structuredClone(value))
  }
  private async createReport(): Promise<AcquisitionDiagnosticReport> {
    const [tools, login] = await Promise.allSettled([this.options.tools.status(), this.options.loginStatus()])
    const status = tools.status === 'fulfilled' ? tools.value : undefined
    return sanitizeDiagnosticReport({ schemaVersion: 1, generatedAt: this.now(), app: this.options.app,
      tools: { status: status ? 'ok' : 'unavailable', items: status?.tools, provider: status?.provider },
      login: login.status === 'fulfilled' ? { youtube: login.value.youtube?.loggedIn, douyu: login.value.douyu?.loggedIn } : {},
      attempts: this.attempts, droppedAttempts: this.droppedAttempts,
    })
  }
}
