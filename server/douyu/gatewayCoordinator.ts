import { abortable, cancelled } from './actionHttp'

/** One account gateway at a time; explicit short operations take precedence over viewing. */
export class DouyuGatewayCoordinator {
  private readonly watches = new Map<string, { controller: AbortController; settled: Promise<unknown> }>()
  private readonly operations = new Map<string, Set<symbol>>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  isBusy(accountId: string): boolean {
    return this.disposed || (this.operations.get(accountId)?.size ?? 0) > 0
  }

  private emit(): void {
    for (const listener of this.listeners) try { listener() } catch { /* An observer cannot hold a connection lease. */ }
  }

  async runShort<T>(accountId: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (this.disposed || signal.aborted) throw cancelled()
    const token = Symbol()
    const tokens = this.operations.get(accountId) ?? new Set<symbol>()
    tokens.add(token)
    this.operations.set(accountId, tokens)
    const watch = this.watches.get(accountId)
    watch?.controller.abort()
    this.emit()
    try {
      // Wait for socket termination, not just for the cancellation signal.
      if (watch) await abortable(watch.settled.catch(() => {}), signal)
      if (this.disposed || signal.aborted) throw cancelled()
      return await run()
    } finally {
      tokens.delete(token)
      if (!tokens.size && this.operations.get(accountId) === tokens) this.operations.delete(accountId)
      this.emit()
    }
  }

  async runWatch<T>(accountId: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted || this.isBusy(accountId) || this.watches.has(accountId)) throw cancelled()
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, controller.signal])
    // Install ownership before invoking user code, including synchronous cancellation callbacks.
    const lease = { controller, settled: Promise.resolve() as Promise<unknown> }
    this.watches.set(accountId, lease)
    const promise = Promise.resolve().then(() => {
      if (combined.aborted || this.disposed) throw cancelled()
      return run(combined)
    })
    lease.settled = promise
    try { return await promise }
    finally {
      if (this.watches.get(accountId) === lease) this.watches.delete(accountId)
      this.emit()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const watch of this.watches.values()) watch.controller.abort()
    this.listeners.clear()
  }
}
