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
      try { await this.opening }
      finally { await this.closed() }
    })()
  }
}

const GENERIC_ERROR_MESSAGES = new Set(['', '操作未完成', '未提供原始错误信息', '[unavailable]', '[redacted]', '[omitted]', '[truncated]'])
const MAX_STARTUP_REASON_LENGTH = 500

/** Sanitize startup exceptions before showing a native dialog before any renderer exists. */
export function formatStartupFailureDialog(error: unknown): { title: string; content: string } {
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
  return {
    title: 'Fy1Sync 启动失败',
    content: reason ? `${summary}\n\n原因：${reason}` : summary,
  }
}

export interface StartupFailureReporterOptions {
  e2e?: boolean
  log?: (message: string) => void
  showErrorBox?: (title: string, content: string) => void
  exit: (code: number) => void
}

export function createStartupFailureReporter(options: StartupFailureReporterOptions): (error: unknown) => void {
  let reported = false
  return (error: unknown) => {
    if (reported) return
    reported = true
    const log = options.log ?? console.error
    try { log('应用启动失败, 请检查构建产物和数据目录') } catch { /* Detached GUI stderr may reject writes. */ }
    if (!options.e2e && options.showErrorBox) {
      const { title, content } = formatStartupFailureDialog(error)
      try { options.showErrorBox(title, content) } catch { /* Exit cleanly even if native dialogs fail. */ }
    }
    options.exit(1)
  }
}
