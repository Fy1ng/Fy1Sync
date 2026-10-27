/** Two independent anonymous transports, one bounded room timeline. */
import { HuyaDanmakuClient, type HuyaDanmakuClientDeps } from './huyaClient'
import { HuyaSliceClient, type HuyaSliceClientDeps } from './huyaSliceClient'
import type { ChatMessage, DanmakuClient, DanmakuClientEvents, DanmakuState, RoomSignal } from './types'

export type HuyaSource = 'cdnws' | 'slice'
type SourceClient = DanmakuClient & { readonly diagnostics?: unknown }
/** Production defaults with optional source factories for isolated transport tests. */
export type HuyaRoomClientDeps = HuyaDanmakuClientDeps & {
  slice?: HuyaSliceClientDeps
  createSource?: (source: HuyaSource, events: DanmakuClientEvents) => SourceClient
}
const WINDOW_MS = 10 * 60_000
const MAX_SEEN = 8192
const MAX_GIFTS_PER_SECOND = 12
type Kind = 'chat' | 'gift' | 'signal'
type Seen = { at: number; mask: number; kind: Kind }
type Received = { chats: number; gifts: number; signals: number }
const add = (n: number, count = 1) => Math.min(Number.MAX_SAFE_INTEGER, n + count)

export class HuyaRoomClient implements DanmakuClient {
  private readonly sources: Record<HuyaSource, SourceClient>
  private readonly states: Record<HuyaSource, DanmakuState> = { cdnws: 'idle', slice: 'idle' }
  private readonly received: Record<HuyaSource, Received> = {
    cdnws: { chats: 0, gifts: 0, signals: 0 }, slice: { chats: 0, gifts: 0, signals: 0 },
  }
  private readonly seen = new Map<string, Seen>()
  private readonly noIdSignals = new Map<string, { at: number; source: HuyaSource }>()
  private readonly now: () => number
  private active = false
  private generation = 0
  private stateValue: DanmakuState = 'idle'
  private chats = 0
  private gifts = 0
  private viewerSignals = 0
  private duplicates = 0
  private crossSourceDuplicates = 0
  private sameSourceRepeats = 0
  private unkeyedMessages = 0
  private signalsWithoutId = 0
  private signalValueDuplicates = 0
  private expired = 0
  private evicted = 0
  private giftWindow = Number.NEGATIVE_INFINITY
  private giftsInWindow = 0

  constructor(readonly room: string, private readonly events: DanmakuClientEvents, deps: HuyaRoomClientDeps = {}) {
    this.now = deps.now ?? Date.now
    const create = (source: HuyaSource): SourceClient => {
      const callbacks: DanmakuClientEvents = {
        onMessage: () => {},
        onObservedMessage: message => { if (this.active) this.message(source, message) },
        onSignal: signal => { if (this.active) this.signal(source, signal) },
        onState: state => { if (this.active) { this.states[source] = state; this.publishState() } },
      }
      return deps.createSource?.(source, callbacks) ?? (source === 'cdnws'
        ? new HuyaDanmakuClient(room, callbacks, deps)
        : new HuyaSliceClient(room, callbacks, { ...deps, ...deps.slice }))
    }
    this.sources = { cdnws: create('cdnws'), slice: create('slice') }
  }

  get state(): DanmakuState { return this.stateValue }

  get diagnostics() {
    this.prune()
    const coverage = { windowMs: WINDOW_MS, capacity: MAX_SEEN, tracked: this.seen.size,
      cdnwsOnlyChats: 0, sliceOnlyChats: 0, bothChats: 0,
      cdnwsOnlyGifts: 0, sliceOnlyGifts: 0, bothGifts: 0,
      cdnwsOnlySignals: 0, sliceOnlySignals: 0, bothSignals: 0,
      evicted: this.evicted, expired: this.expired }
    for (const row of this.seen.values()) {
      const suffix = row.kind === 'chat' ? 'Chats' : row.kind === 'gift' ? 'Gifts' : 'Signals'
      const prefix = row.mask === 3 ? 'both' : row.mask === 1 ? 'cdnwsOnly' : 'sliceOnly'
      const key = (prefix + suffix) as 'bothChats'
      coverage[key]++
    }
    return {
      chats: this.chats, gifts: this.gifts, viewerSignals: this.viewerSignals,
      duplicates: this.duplicates, crossSourceDuplicates: this.crossSourceDuplicates, sameSourceRepeats: this.sameSourceRepeats,
      unkeyedMessages: this.unkeyedMessages, signalsWithoutId: this.signalsWithoutId, signalValueDuplicates: this.signalValueDuplicates,
      coverage,
      sources: {
        cdnws: { state: this.states.cdnws, ...this.received.cdnws, diagnostics: this.sources.cdnws.diagnostics ?? null },
        slice: { state: this.states.slice, ...this.received.slice, diagnostics: this.sources.slice.diagnostics ?? null },
      },
    }
  }

  connect(): void {
    if (this.active) return
    this.active = true
    const generation = ++this.generation
    this.states.cdnws = this.states.slice = 'connecting'
    this.publishState()
    for (const source of ['cdnws', 'slice'] as const) {
      if (!this.active || generation !== this.generation) break
      try { this.sources[source].connect() }
      catch { this.states[source] = 'reconnecting'; this.publishState() }
    }
  }

  close(): void {
    if (!this.active && this.stateValue === 'closed') return
    this.active = false
    this.generation++
    for (const source of ['cdnws', 'slice'] as const) {
      try { this.sources[source].close() } catch { /* Independent teardown. */ }
      this.states[source] = 'closed'
    }
    this.seen.clear()
    this.noIdSignals.clear()
    this.stateValue = 'closed'
    this.events.onState('closed')
  }

  private publishState(): void {
    const values = Object.values(this.states)
    const state: DanmakuState = values.includes('connected') ? 'connected'
      : values.includes('connecting') ? 'connecting' : 'reconnecting'
    if (state === this.stateValue) return
    this.stateValue = state
    this.events.onState(state, state === 'connected' ? undefined
      : state === 'connecting' ? '正在连接虎牙弹幕.' : '虎牙弹幕两路暂时不可用, 正在重新连接.')
  }

  private message(source: HuyaSource, message: ChatMessage): void {
    if (message.platform !== 'huya') return
    const generation = this.generation
    const kind = message.system ? 'gift' : 'chat'
    const count = kind === 'gift' ? 'gifts' : 'chats'
    this.received[source][count] = add(this.received[source][count])
    const id = /^huya:[^:]+:(\d+):([1-9]\d{0,18})$/.exec(message.id)
    if (id) { if (!this.accept(source, 'id:' + id[1] + ':' + id[2], kind)) return }
    else this.unkeyedMessages = add(this.unkeyedMessages)
    this.events.onObservedMessage?.(message)
    if (!this.active || generation !== this.generation) return
    if (kind === 'gift') {
      const now = this.now()
      if (now < this.giftWindow || now - this.giftWindow >= 1000) { this.giftWindow = now; this.giftsInWindow = 0 }
      if (this.giftsInWindow >= MAX_GIFTS_PER_SECOND) return
      this.giftsInWindow++
      this.gifts = add(this.gifts)
    } else this.chats = add(this.chats)
    this.events.onMessage(message)
  }

  private signal(source: HuyaSource, signal: RoomSignal): void {
    if (signal.platform !== 'huya' || signal.kind !== 'viewers') return
    this.received[source].signals = add(this.received[source].signals)
    if (signal.messageId && /^[1-9]\d{0,18}$/.test(signal.messageId)) {
      if (!this.accept(source, 'id:8006:' + signal.messageId, 'signal')) return
    } else {
      this.signalsWithoutId = add(this.signalsWithoutId)
      const now = this.now(), key = String(signal.count), previous = this.noIdSignals.get(key)
      if (previous && previous.source !== source && now >= previous.at && now - previous.at <= 1000) {
        this.signalValueDuplicates = add(this.signalValueDuplicates)
        return
      }
      if (this.noIdSignals.size >= 64) this.noIdSignals.delete(this.noIdSignals.keys().next().value!)
      this.noIdSignals.set(key, { at: now, source })
    }
    this.viewerSignals = add(this.viewerSignals)
    this.events.onSignal?.(signal)
  }

  private accept(source: HuyaSource, key: string, kind: Kind): boolean {
    this.prune()
    const mask = source === 'cdnws' ? 1 : 2
    const row = this.seen.get(key)
    if (row) {
      this.duplicates = add(this.duplicates)
      if (row.mask & mask) this.sameSourceRepeats = add(this.sameSourceRepeats)
      else this.crossSourceDuplicates = add(this.crossSourceDuplicates)
      row.mask |= mask
      // First-receive time defines a fixed window; repetitions cannot pin entries forever.
      return false
    }
    if (this.seen.size >= MAX_SEEN) {
      this.seen.delete(this.seen.keys().next().value!)
      this.evicted = add(this.evicted)
    }
    this.seen.set(key, { at: this.now(), mask, kind })
    return true
  }

  private prune(): void {
    const now = this.now()
    for (const [key, row] of this.seen) {
      if (now >= row.at && now - row.at < WINDOW_MS) break
      this.seen.delete(key)
      this.expired = add(this.expired)
    }
  }
}
