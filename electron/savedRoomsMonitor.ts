import type { SavedRoom, SavedRoomMetadata } from './featureContracts'
import { SavedRoomsError, type SavedRoomsStore } from './savedRooms'
import { savedRoomKey } from '../src/core/savedRoomIdentity'

export type RoomMetadataCollector = (room: SavedRoom, signal: AbortSignal) => Promise<SavedRoomMetadata>
const INTERVAL = 60_000
const MANUAL_INTERVAL = 15_000

/** Main owns polling independently of every window and panel. */
export class SavedRoomsMonitor {
  private readonly lifetime = new AbortController()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly nextAt = new Map<string, number>()
  private readonly failures = new Map<string, number>()
  private timer?: ReturnType<typeof setTimeout>
  private pumpTimer?: ReturnType<typeof setTimeout>
  private lastRequestAt = -Infinity
  private running = 0
  private readonly pending = new Map<string, { room: SavedRoom; run: () => void }>()

  constructor(private readonly options: {
    store: SavedRoomsStore
    collect: RoomMetadataCollector
    changed: (rooms: SavedRoom[]) => void
    now?: () => number
    enabled?: boolean
    intervalMs?: number
  }) {}

  start(): void { this.schedule() }

  changed(): void {
    this.options.changed(this.options.store.list())
    this.schedule(0)
  }

  async refresh(args?: { id?: string }, automatic = false): Promise<SavedRoom[]> {
    if (this.lifetime.signal.aborted) return this.options.store.list()
    const rooms = this.options.store.list().filter(room => args?.id === undefined || room.id === args.id)
    if (args?.id && !rooms.length) throw new SavedRoomsError('invalid-arguments')
    const now = this.now()
    await Promise.all(rooms.filter(room => room.platform !== 'direct').map(room => {
      const key = this.key(room)
      const existing = this.flights.get(key)
      if (existing) return existing
      if (automatic ? (this.nextAt.get(key) ?? (room.lastAttemptAt === undefined ? 0 : room.lastAttemptAt + (this.options.intervalMs ?? INTERVAL))) > now : now - (room.lastAttemptAt ?? -Infinity) < MANUAL_INTERVAL) return
      if (this.options.enabled === false) return
      return this.enqueue(key, room)
    }))
    return this.options.store.list()
  }

  dispose(): void {
    this.lifetime.abort()
    if (this.timer) clearTimeout(this.timer)
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    // Settle queued jobs so in-flight IPC and shutdown never wait on a discarded queue.
    for (const item of this.pending.values()) item.run()
    this.pending.clear()
  }

  private key(room: SavedRoom): string { return savedRoomKey(room.platform, room.metadata?.url ?? room.input) }
  private now(): number { return (this.options.now ?? Date.now)() }

  private enqueue(key: string, room: SavedRoom): Promise<void> {
    let release!: () => void
    const completion = new Promise<void>(resolve => { release = resolve })
    const flight = completion.finally(() => { this.flights.delete(key); this.pump() })
    this.flights.set(key, flight)
    this.pending.set(key, { room, run: () => {
      if (this.lifetime.signal.aborted) { release(); return }
      this.running++
      void this.collect(key, room).finally(() => { this.running--; release() })
    } })
    this.pump()
    return flight
  }

  private pump(): void {
    if (this.lifetime.signal.aborted || this.running >= 2 || !this.pending.size || this.pumpTimer) return
    const delay = Math.max(0, this.lastRequestAt + 500 - this.now())
    if (delay > 0) {
      this.pumpTimer = setTimeout(() => { this.pumpTimer = undefined; this.pump() }, delay)
      this.pumpTimer.unref?.()
      return
    }
    for (const [key, item] of this.pending) {
      this.pending.delete(key)
      this.lastRequestAt = this.now()
      item.run()
      break
    }
    this.pump()
  }

  private async collect(key: string, room: SavedRoom): Promise<void> {
    const attemptedAt = this.now()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(25_000)])
    try {
      // Providers also receive the signal. The race bounds providers that ignore cancellation.
      const result = await new Promise<SavedRoomMetadata>((resolve, reject) => {
        const abort = () => reject(new Error('Metadata request cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => this.options.collect(room, signal)).then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort))
        if (signal.aborted) abort()
      })
      if (signal.aborted) throw new Error('Metadata request cancelled')
      // A returned platform start time wins. Otherwise retain the known broadcast start,
      // and record a new observation only after a confirmed offline/replay -> live edge.
      for (const current of this.options.store.list().filter(item => this.key(item) === key)) {
        const previous = current.metadata
        const snapshot = { ...result }
        if (snapshot.lastStartedAt === null) {
          const newBroadcast = snapshot.status === 'live' && previous && ['offline', 'replay'].includes(previous.status)
          snapshot.lastStartedAt = newBroadcast ? snapshot.collectedAt : previous?.lastStartedAt ?? (snapshot.status === 'live' ? snapshot.collectedAt : null)
          snapshot.startTimeSource = newBroadcast || (!previous?.lastStartedAt && snapshot.lastStartedAt !== null) ? 'observed' : previous?.startTimeSource ?? null
        }
        this.options.store.recordAttempt(current.id, attemptedAt, snapshot)
      }
      this.failures.delete(key)
      this.nextAt.set(key, this.now() + (this.options.intervalMs ?? INTERVAL))
    } catch {
      if (this.lifetime.signal.aborted) return
      const failures = (this.failures.get(key) ?? 0) + 1
      this.failures.set(key, failures)
      this.nextAt.set(key, this.now() + Math.min(300_000, INTERVAL * 2 ** Math.min(failures - 1, 3)))
      for (const current of this.options.store.list().filter(item => this.key(item) === key)) {
        try { this.options.store.recordAttempt(current.id, attemptedAt, current.metadata ? '更新失败，显示上次信息' : '暂未获取直播状态，可稍后刷新') }
        catch { /* Persistence failures must not discard the in-memory last good snapshot. */ }
      }
    } finally {
      if (!this.lifetime.signal.aborted) this.options.changed(this.options.store.list())
    }
  }

  private schedule(delay = 1_000): void {
    if (this.lifetime.signal.aborted || this.options.enabled === false) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh(undefined, true).catch(() => undefined).finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }
}
