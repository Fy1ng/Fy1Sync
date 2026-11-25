import { errorDetails, redactErrorText } from '../src/core/errorDetails'

interface MainWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

interface LifecycleOptions {
  window(): MainWindow | null
  start(): Promise<void>
  dispose(): Promise<void> | undefined
  present?: boolean
  shutdownTimeoutMs?: number
  onShutdownTimeout?: () => void
}

/** Reopening must wait for the old IPC, protocol handlers and media workers to close. */
export class ApplicationLifecycle {
  private opening: Promise<void> | undefined
  private cleaning: Promise<void> | undefined
  private shutdown: Promise<void> | undefined
  private requested = false
  private stopping = false

  constructor(private readonly options: LifecycleOptions) {}

  activate(): Promise<void> {
    if (this.stopping) return Promise.resolve()
    this.requested = true
    return this.opening ??= (async () => {
      do {
        this.requested = false
        await this.cleaning
        if (this.stopping) return
        let window = this.options.window()
        if (!window || window.isDestroyed()) {
          await this.options.start()
          window = this.options.window()
        }
        if (!this.stopping && this.options.present !== false && window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      } while (this.requested && !this.stopping)
    })().finally(() => { this.opening = undefined })
  }

  closed(): Promise<void> {
    return this.cleaning ??= Promise.resolve().then(() => this.options.dispose()).finally(() => { this.cleaning = undefined })
  }

  quit(): Promise<void> {
    this.stopping = true
    this.requested = false
    return this.shutdown ??= (async () => {
      const work = (async () => {
        try { await this.opening }
        finally { await this.closed() }
      })()
      const timeoutMs = this.options.shutdownTimeoutMs
      if (!timeoutMs || timeoutMs <= 0) {
        await work
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          work.then(() => 'completed' as const),
          new Promise<'timed-out'>(resolve => {
            timer = setTimeout(() => resolve('timed-out'), timeoutMs)
            timer.unref?.()
          }),
        ])
        if (outcome === 'timed-out') {
          void work.catch(() => {})
          this.options.onShutdownTimeout?.()
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
  }
}

const GENERIC_ERROR_MESSAGES = new Set(['', '操作未完成', '未提供原始错误信息', '[unavailable]', '[redacted]', '[omitted]', '[truncated]'])
const MAX_STARTUP_REASON_LENGTH = 500

export interface StartupFailureFormatOptions {
  logFilePath?: string
}

/** Sanitize startup exceptions before showing a native dialog before any renderer exists. */
export function formatStartupFailureDialog(error: unknown, options: StartupFailureFormatOptions = {}): { title: string; content: string } {
  const summary = '应用无法完成初始化，请检查安装包或解压目录是否完整，以及应用数据目录是否可读写且未设置为软链接或目录联接。'
  let reason = ''
  if (typeof error === 'string') {
    reason = redactErrorText(error).trim()
  } else if (error !== null && error !== undefined) {
    const detail = errorDetails(error)
    const message = typeof detail.message === 'string' ? redactErrorText(detail.message).trim() : ''
    const code = typeof detail.code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(detail.code) ? detail.code : ''
    reason = !GENERIC_ERROR_MESSAGES.has(message) ? (code && !message.includes(code) ? `${message} (${code})` : message) : code
  }
  if (GENERIC_ERROR_MESSAGES.has(reason)) reason = ''
  if (reason.length > MAX_STARTUP_REASON_LENGTH) reason = reason.slice(0, MAX_STARTUP_REASON_LENGTH) + '…'
  const logPath = typeof options.logFilePath === 'string' ? redactErrorText(options.logFilePath).trim() : ''
  let content = reason ? `${summary}\n\n原因：${reason}` : summary
  if (logPath) content += `\n\n诊断日志：${logPath}`
  return {
    title: 'Fy1Sync 启动失败',
    content,
  }
}

export type StartupRecoveryAction = 'safe-restart' | 'open-logs' | 'exit'

export interface StartupFailureReporterOptions {
  e2e?: boolean
  logFilePath?: string
  log?: (message: string) => void
  logError?: (error: unknown) => void
  showErrorBox?: (title: string, content: string) => void
  showRecoveryDialog?: (dialog: { title: string; content: string }) => StartupRecoveryAction
  onSafeRestart?: () => void
  onOpenLogs?: () => void
  exit: (code: number) => void
}

export function createStartupFailureReporter(options: StartupFailureReporterOptions): (error: unknown) => void {
  let reported = false
  return (error: unknown) => {
    if (reported) return
    reported = true
    try { options.logError?.(error) } catch { /* Logger must never throw. */ }
    const log = options.log ?? console.error
    try { log('应用启动失败, 请检查构建产物和数据目录') } catch { /* Detached GUI stderr may reject writes. */ }
    if (!options.e2e) {
      const formatted = formatStartupFailureDialog(error, { logFilePath: options.logFilePath })
      if (options.showRecoveryDialog) {
        try {
          const action = options.showRecoveryDialog(formatted)
          if (action === 'safe-restart' && options.onSafeRestart) {
            try {
              options.onSafeRestart()
              options.exit(0)
              return
            } catch {
              options.exit(1)
              return
            }
          }
          if (action === 'open-logs') {
            try { options.onOpenLogs?.() } catch { /* Ignore shell open errors during exit. */ }
          }
          options.exit(1)
          return
        } catch {
          // Fall back to showErrorBox when native message boxes cannot run before app ready.
        }
      }
      if (options.showErrorBox) {
        try { options.showErrorBox(formatted.title, formatted.content) } catch { /* Exit cleanly even if native dialogs fail. */ }
      }
    }
    options.exit(1)
  }
}
