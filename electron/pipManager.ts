import type { ResolvedStream } from '../server/platforms'
import { isStreamId, type StreamId } from './streamIdentity'

export interface PipOptions { lowPower: boolean; recoverStalls: boolean; width: number; height: number }
export interface PipState {
  phase: 'closed' | 'opening' | 'ready' | 'failed'
  streamId: StreamId | null
  source: ResolvedStream | null
  options: PipOptions
  audioOwner: 'main' | 'pip'
  recoveryRevision: number
  recoveryAttempts: number
  message: string | null
  sendContext: { accountId: string | null; room: string | null; canAttempt: boolean }
}
export interface PipReport { ready: boolean; playing: boolean; mediaTime: number; frameCount: number }
export interface PipWindowPort {
  id: number
  load(): Promise<void>
  show(): void
  close(): void
  resize(width: number, height: number): void
  onClosed(listener: () => void): () => void
}
export interface PipManagerOptions {
  createWindow: () => PipWindowPort
  source: (id: StreamId) => ResolvedStream | null
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  sendContext?: (room: string | null) => { accountId: string | null; canAttempt: boolean }
}
export class PipError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'source-unavailable' | 'forbidden' | 'disposed') {
    super({ 'invalid-arguments': '画中画参数无效', 'source-unavailable': '直播源尚未就绪', forbidden: '画中画窗口无权执行该操作', disposed: '画中画服务已关闭' }[code])
  }
}
const DEFAULT_OPTIONS: PipOptions = { lowPower: false, recoverStalls: true, width: 480, height: 270 }

/** Owns only the native shell and its authority. The /pip renderer is Claude's handoff. */
export class PipManager {
  private value: Omit<PipState, 'sendContext'> = { phase: 'closed', streamId: null, source: null, options: { ...DEFAULT_OPTIONS },
    audioOwner: 'main', recoveryRevision: 0, recoveryAttempts: 0, message: null }
  private window: PipWindowPort | null = null
  private detachWindow: (() => void) | null = null
  private readonly listeners = new Set<(state: PipState) => void>()
  private timer: unknown = null
  private disposed = false
  private openedAt = 0
  private progressAt = 0
  private mediaTime = -1
  private frameCount = -1
  private playing = false
  private reportAt = 0
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  constructor(private readonly deps: PipManagerOptions) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }
  state(): PipState {
    const room = this.value.source?.sourceRoom ?? null
    const sender = this.deps.sendContext?.(room) ?? { accountId: null, canAttempt: false }
    return structuredClone({ ...this.value, sendContext: { ...sender, room } })
  }
  windowId(): number | null { return this.window?.id ?? null }
  subscribe(listener: (state: PipState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state())
    return () => { this.listeners.delete(listener) }
  }
  async open(streamId: StreamId, options: Partial<PipOptions> = {}): Promise<PipState> {
    if (this.disposed) throw new PipError('disposed')
    if (!isStreamId(streamId)) throw new PipError('invalid-arguments')
    const settings = readPipOptions(options, this.value.options)
    const source = this.deps.source(streamId)
    if (!source || !isLocalPlayback(source.url)) throw new PipError('source-unavailable')
    this.close()
    const window = this.deps.createWindow()
    this.window = window
    this.value = { phase: 'opening', streamId, source, options: settings, audioOwner: 'main', recoveryRevision: 0, recoveryAttempts: 0, message: null }
    this.openedAt = this.progressAt = this.now()
    this.reportAt = 0; this.mediaTime = -1; this.frameCount = -1; this.playing = false
    this.detachWindow = window.onClosed(() => { if (this.window === window) this.closed() })
    window.resize(settings.width, settings.height)
    this.publish()
    this.arm()
    try { await window.load() }
    catch {
      if (this.window === window) this.fail('画中画页面尚未就绪, 请完成 Claude 前端接入后重试')
    }
    return this.state()
  }
  close(): PipState {
    const window = this.window
    this.closed()
    try { window?.close() } catch { /* A destroyed native shell is already closed. */ }
    return this.state()
  }
  configure(patch: Partial<PipOptions>): PipState {
    const options = readPipOptions(patch, this.value.options)
    this.value.options = options
    this.window?.resize(options.width, options.height)
    this.publish()
    return this.state()
  }
  report(senderId: number, raw: PipReport): PipState {
    if (senderId !== this.window?.id) throw new PipError('forbidden')
    if (!raw || Object.keys(raw).some(k => !['ready', 'playing', 'mediaTime', 'frameCount'].includes(k))
      || typeof raw.ready !== 'boolean' || typeof raw.playing !== 'boolean'
      || !Number.isFinite(raw.mediaTime) || raw.mediaTime < 0
      || !Number.isSafeInteger(raw.frameCount) || raw.frameCount < 0) throw new PipError('invalid-arguments')
    const now = this.now()
    if (raw.mediaTime !== this.mediaTime || raw.frameCount > this.frameCount || !raw.playing || !this.playing) this.progressAt = now
    this.mediaTime = raw.mediaTime; this.frameCount = raw.frameCount; this.playing = raw.playing; this.reportAt = now
    if (raw.ready && this.value.phase === 'opening') {
      this.value.phase = 'ready'
      this.value.audioOwner = 'pip'
      this.window.show()
      this.publish()
    }
    return this.state()
  }
  /** A stalled renderer reloads its existing local playlist; it cannot replace a source. */
  recover(): PipState {
    if (!this.window || this.value.phase !== 'ready') return this.state()
    if (this.value.recoveryAttempts >= 3) { this.fail('画中画恢复次数已用完, 请关闭后重新打开'); return this.state() }
    this.value.recoveryAttempts++
    this.value.recoveryRevision++
    this.progressAt = this.now()
    this.publish()
    return this.state()
  }
  permits(senderId: number, method: string, args: unknown): boolean {
    if (senderId !== this.window?.id || !this.value.streamId) return false
    if (['getEnhancedPip', 'reportEnhancedPip', 'closeEnhancedPip', 'recoverEnhancedPip', 'setEnhancedPipOptions', 'getDanmakuFeatures'].includes(method)) return true
    const value = args && typeof args === 'object' ? args as Record<string, unknown> : {}
    if (method === 'getStreamPlayback') return value.id === this.value.streamId
    if (['activateDouyuRoom', 'sendComposedDouyuMessage', 'getDouyuRoomInsights', 'reportDouyuPlayback', 'getDanmakuRate', 'getDanmakuUserDetails'].includes(method)) return value.room === this.value.source?.sourceRoom
    return false
  }
  permitsRoom(senderId: number, room: string): boolean {
    return senderId === this.window?.id && room === this.value.source?.sourceRoom
  }
  dispose(): void { if (!this.disposed) { this.close(); this.disposed = true; this.listeners.clear() } }
  private arm(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.window || this.disposed || this.value.phase === 'failed') return
      const now = this.now()
      if (this.value.phase === 'opening' && now - this.openedAt >= 20_000) this.fail('画中画页面未报告就绪, 请完成 Claude 前端接入')
      else if (this.value.phase === 'ready' && now - this.reportAt >= 20_000) this.fail('画中画窗口已失去响应')
      else if (this.playing && this.value.options.recoverStalls && now - this.progressAt >= 12_000) this.recover()
      if (this.state().phase !== 'failed') this.arm()
    }, 1_000)
  }
  private fail(message: string): void {
    this.value.phase = 'failed'; this.value.audioOwner = 'main'; this.value.message = message
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.publish()
  }
  private closed(): void {
    this.detachWindow?.(); this.detachWindow = null
    this.window = null
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.value = { ...this.value, phase: 'closed', streamId: null, source: null, audioOwner: 'main', message: null }
    this.publish()
  }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.state()) } catch { /* Isolate observers. */ } } }
}

export function readPipOptions(raw: unknown, fallback: PipOptions = DEFAULT_OPTIONS): PipOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PipError('invalid-arguments')
  const v = raw as Record<string, unknown>
  if (Object.keys(v).some(k => !['lowPower', 'recoverStalls', 'width', 'height'].includes(k))) throw new PipError('invalid-arguments')
  const next = { ...fallback, ...v }
  if (typeof next.lowPower !== 'boolean' || typeof next.recoverStalls !== 'boolean'
    || !Number.isSafeInteger(next.width) || next.width < 240 || next.width > 1920
    || !Number.isSafeInteger(next.height) || next.height < 135 || next.height > 1080) throw new PipError('invalid-arguments')
  return next
}
function isLocalPlayback(value: string): boolean {
  if (/^\/test-sources\/[\w/.-]+$/.test(value) && !value.includes('..')) return true
  try { const u = new URL(value); return u.protocol === 'app:' && u.hostname === 'app' && !u.port && !u.username && !u.password
    && /^\/(?:buffer|media)\//.test(u.pathname) && !u.hash && !u.search } catch { return false }
}
