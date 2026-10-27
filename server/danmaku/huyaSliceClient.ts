/** Anonymous receive-only HTTP source. Every new connection gets a new WUP signature. */
import { safeFetchStream, SafeFetchStreamError } from '../safeFetchStream'
import { requestHuyaChatSignal, type HuyaChatSignal } from '../platforms/huyaChatSignal'
import { defaultResolveHuyaDanmakuRoom, type HuyaDanmakuClientDeps } from './huyaClient'
import { decodeHuyaPush } from './huyaProtocol'
import { HuyaSliceParser } from './huyaSlice'
import type { DanmakuClient, DanmakuClientEvents, DanmakuState } from './types'

const CONNECT_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 30_000
const IDLE_TIMEOUT_MS = 60_000
const MAX_BUFFERED_BYTES = 1_048_576
const MAX_CHUNK_BYTES = 262_144
const SIGNATURE_MARGIN_MS = 5_000
const MAX_UNKNOWN_URIS = 64
const add = (value: number, count = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + count)

export type HuyaSliceClientDeps = HuyaDanmakuClientDeps & {
  requestSignal?: (presenterUid: bigint, signal: AbortSignal) => Promise<HuyaChatSignal>
  stream?: typeof safeFetchStream
}
type Failure = 'metadata' | 'signature' | 'stale-signature' | 'http' | 'timeout' | 'stream' | 'ended'

export class HuyaSliceClient implements DanmakuClient {
  private readonly resolveRoom: NonNullable<HuyaSliceClientDeps['resolveRoom']>
  private readonly requestSignal: NonNullable<HuyaSliceClientDeps['requestSignal']>
  private readonly stream: typeof safeFetchStream
  private readonly now: () => number
  private readonly setTimer: NonNullable<HuyaSliceClientDeps['setTimer']>
  private readonly clearTimer: NonNullable<HuyaSliceClientDeps['clearTimer']>
  private readonly parser: HuyaSliceParser
  private controller: AbortController | null = null
  private reconnect: unknown = null
  private stageTimer: unknown = null
  private generation = 0
  private feedingGeneration: number | null = null
  private attempts = 0
  private stopped = true
  private stateValue: DanmakuState = 'idle'
  private readonly stats = { signatureRequests: 0, resigns: 0, staleSignatures: 0, connections: 0,
    reconnects: 0, httpErrors: 0, lastHttpStatus: null as number | null, timeouts: 0, failures: 0, bytes: 0, chunks: 0,
    chats: 0, gifts: 0, viewerSignals: 0, malformedPushes: 0, unknownUris: 0,
    unknownUriCounts: {} as Record<string, number>, signatureTtlSeconds: 0,
    connectionAgeSeconds: 0, connectedBeyondTtl: false, lastFailure: null as Failure | null }

  constructor(readonly room: string, private readonly events: DanmakuClientEvents, deps: HuyaSliceClientDeps = {}) {
    this.resolveRoom = deps.resolveRoom ?? defaultResolveHuyaDanmakuRoom
    this.requestSignal = deps.requestSignal ?? requestHuyaChatSignal
    this.stream = deps.stream ?? safeFetchStream
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as never))
    this.parser = new HuyaSliceParser(data => this.push(data), this.now)
  }

  get state(): DanmakuState { return this.stateValue }
  get diagnostics() {
    return { ...this.stats, unknownUriCounts: { ...this.stats.unknownUriCounts }, parser: this.parser.diagnostics }
  }

  connect(): void {
    if (this.controller) return
    if (this.reconnect !== null) { this.clearTimer(this.reconnect); this.reconnect = null }
    this.stopped = false
    const controller = new AbortController(), generation = ++this.generation
    this.controller = controller
    this.setState('connecting')
    // Defer a restart requested inside an observer until the old feed has unwound.
    void Promise.resolve().then(() => this.run(controller, generation))
  }

  close(): void {
    this.stopped = true
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.clearStageTimer()
    if (this.reconnect !== null) this.clearTimer(this.reconnect)
    this.reconnect = null
    this.setState('closed')
  }

  private async run(controller: AbortController, generation: number): Promise<void> {
    const current = () => generation === this.generation && !this.stopped
    let failure: Failure = 'metadata'
    if (!current()) return
    this.parser.reset()
    try {
      const metadata = await this.deadline(() => this.resolveRoom(this.room), controller)
      if (!current()) return
      if (metadata.room !== this.room) throw new Error('Invalid room identity')
      failure = 'signature'
      if (this.stats.signatureRequests > 0) this.stats.resigns = add(this.stats.resigns)
      this.stats.signatureRequests = add(this.stats.signatureRequests)
      const signature = await this.deadline(() => this.requestSignal(metadata.presenterUid, controller.signal), controller)
      if (!current()) return
      if (!Number.isFinite(signature.expiresAt) || signature.expiresAt - this.now() <= SIGNATURE_MARGIN_MS) {
        failure = 'stale-signature'
        this.stats.staleSignatures = add(this.stats.staleSignatures)
        throw new Error('Signature expires too soon')
      }
      this.stats.signatureTtlSeconds = signature.ttlSeconds
      failure = 'stream'
      let openedAt = this.now()
      const baselinePackets = this.parser.diagnostics.packets
      await this.stream(signature.url, { enabled: true, hosts: ['*.huya.com'], allowNonStandardPorts: false,
        allowNonLoopbackTargets: false, maxRedirects: 0, requestTimeoutMs: CONNECT_TIMEOUT_MS }, {
        signal: controller.signal, connectTimeoutMs: CONNECT_TIMEOUT_MS, readTimeoutMs: READ_TIMEOUT_MS,
        idleTimeoutMs: IDLE_TIMEOUT_MS, maxBufferedBytes: MAX_CHUNK_BYTES,
        onOpen: () => {
          if (!current()) return
          openedAt = this.now()
          this.stats.connectionAgeSeconds = 0
          this.stats.connections = add(this.stats.connections)
        },
        onChunk: chunk => {
          if (!current()) return
          if (chunk.byteLength + this.parser.diagnostics.bufferedBytes > MAX_BUFFERED_BYTES) {
            throw new Error('Chat stream buffer limit')
          }
          this.stats.bytes = add(this.stats.bytes, chunk.byteLength)
          this.stats.chunks = add(this.stats.chunks)
          this.feedingGeneration = generation
          try { this.parser.feed(chunk) }
          finally { this.feedingGeneration = null }
          if (!current() || this.parser.diagnostics.packets <= baselinePackets) return
          this.stats.connectionAgeSeconds = Math.max(0, Math.floor((this.now() - openedAt) / 1000))
          if (this.now() >= signature.expiresAt) this.stats.connectedBeyondTtl = true
          // TTL limits opening a stream. A healthy established stream stays open.
          if (this.now() - openedAt >= 30_000) this.attempts = 0
          if (this.stateValue !== 'connected') this.setState('connected')
        },
      })
      failure = 'ended'
    } catch (error) {
      if (!current()) return
      if (error instanceof SafeFetchStreamError) {
        if (error.code === 'http-status') {
          failure = 'http'
          this.stats.httpErrors = add(this.stats.httpErrors)
          this.stats.lastHttpStatus = error.status ?? null
        }
        else if (error.code.endsWith('timeout')) { failure = 'timeout'; this.stats.timeouts = add(this.stats.timeouts) }
      } else if (controller.signal.aborted) { failure = 'timeout'; this.stats.timeouts = add(this.stats.timeouts) }
    } finally {
      // Abort this attempt even on EOF; its signed URL is never retained for reuse.
      controller.abort()
      if (current()) {
        this.clearStageTimer()
        this.controller = null
        this.parser.reset()
        this.stats.failures = add(this.stats.failures)
        this.stats.lastFailure = failure
        this.stats.reconnects = add(this.stats.reconnects)
        this.attempts = Math.min(this.attempts + 1, 6)
        this.setState('reconnecting', '虎牙聊天流暂时不可用, 正在重新连接.')
        if (current()) this.reconnect = this.setTimer(() => {
          this.reconnect = null
          this.connect()
        }, Math.min(1000 * 2 ** (this.attempts - 1), 30_000))
      }
    }
  }

  /** Race metadata/signing against abort, including injected promises that never settle. */
  private async deadline<T>(start: () => Promise<T>, controller: AbortController): Promise<T> {
    const timer = this.setTimer(() => controller.abort(), CONNECT_TIMEOUT_MS)
    this.stageTimer = timer
    let abort = () => {}
    try {
      return await Promise.race([Promise.resolve().then(start), new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('Chat connection cancelled'))
        controller.signal.addEventListener('abort', abort, { once: true })
        if (controller.signal.aborted) abort()
      })])
    } finally {
      controller.signal.removeEventListener('abort', abort)
      this.clearTimer(timer)
      if (this.stageTimer === timer) this.stageTimer = null
    }
  }

  private clearStageTimer(): void {
    if (this.stageTimer !== null) this.clearTimer(this.stageTimer)
    this.stageTimer = null
  }

  private push(data: Uint8Array): void {
    const generation = this.feedingGeneration
    if (generation !== this.generation || this.stopped || !this.controller || this.controller.signal.aborted) return
    const result = decodeHuyaPush(data, this.room, this.now())
    if (result.malformed) { this.stats.malformedPushes = add(this.stats.malformedPushes); return }
    this.stats.unknownUris = add(this.stats.unknownUris, result.unknownUris)
    for (const [uri, count] of Object.entries(result.unknownUriCounts)) {
      const key = Object.hasOwn(this.stats.unknownUriCounts, uri) || Object.keys(this.stats.unknownUriCounts).length < MAX_UNKNOWN_URIS ? uri : 'other'
      this.stats.unknownUriCounts[key] = add(this.stats.unknownUriCounts[key] ?? 0, count)
    }
    for (const message of result.messages) {
      this.stats[message.system ? 'gifts' : 'chats'] = add(this.stats[message.system ? 'gifts' : 'chats'])
      this.events.onObservedMessage?.(message)
      if (this.stopped || generation !== this.generation) return
      this.events.onMessage(message)
    }
    for (const signal of result.signals) {
      if (this.stopped || generation !== this.generation) return
      this.stats.viewerSignals = add(this.stats.viewerSignals)
      this.events.onSignal?.(signal)
    }
  }

  private setState(state: DanmakuState, detail?: string): void { this.stateValue = state; this.events.onState(state, detail) }
}
