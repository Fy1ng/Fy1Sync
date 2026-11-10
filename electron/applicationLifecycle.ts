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
