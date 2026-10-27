import { randomUUID } from 'node:crypto'
import type { Acquisition } from './acquisition'
import type { BufferState } from './bufferManager'
import { isExtraStreamId, isStreamId, type StreamId } from './streamIdentity'
import type { PlatformKind, ResolvedStream, ResolveResult } from '../server/platforms'

export interface OpenStreamInput { input: string; platform?: PlatformKind; quality?: string; preferAdaptive?: boolean }
export interface StreamSessionView {
  id: StreamId
  input: string
  phase: 'opening' | 'ready' | 'failed'
  stream: ResolvedStream | null
  buffer: BufferState | null
  error: string | null
}
export interface StreamSessionsSnapshot { maxExtraStreams: number; sessions: StreamSessionView[] }
export class StreamSessionError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'stream-limit' | 'stream-not-found' | 'stream-cancelled' | 'disposed') {
    super({ 'invalid-arguments': '直播会话参数无效', 'stream-limit': '已达到当前直播会话资源上限',
      'stream-not-found': '直播会话不存在', 'stream-cancelled': '直播会话已关闭', disposed: '直播会话服务已关闭' }[code])
  }
}
type Runtime = { view: StreamSessionView; revision: number }
type AcquisitionPort = Pick<Acquisition, 'resolve' | 'switchQuality' | 'restart' | 'stop' | 'subscribe' | 'describe'>

/** Extra streams share acquisition and capability routes, not synchronization state. */
export class StreamSessions {
  private readonly sessions = new Map<StreamId, Runtime>()
  private readonly listeners = new Set<(value: StreamSessionsSnapshot) => void>()
  private readonly release: () => void
  private disposed = false
  constructor(private readonly acquisition: AcquisitionPort, private readonly maxExtraStreams = 16,
    private readonly id: () => string = () => `stream-${randomUUID().replaceAll('-', '')}`) {
    if (!Number.isSafeInteger(maxExtraStreams) || maxExtraStreams < 1 || maxExtraStreams > 256) throw new StreamSessionError('invalid-arguments')
    this.release = acquisition.subscribe(state => {
      const session = this.sessions.get(state.role)
      if (!session) return
      session.view.buffer = { ...state }
      this.publish()
    })
  }
  snapshot(): StreamSessionsSnapshot {
    return structuredClone({ maxExtraStreams: this.maxExtraStreams, sessions: [...this.sessions.values()].map(s => s.view) })
  }
  subscribe(listener: (value: StreamSessionsSnapshot) => void): () => void {
    if (!this.disposed) this.listeners.add(listener)
    listener(this.snapshot())
    return () => { this.listeners.delete(listener) }
  }
  async open(raw: OpenStreamInput): Promise<StreamSessionView> {
    this.alive()
    const input = readOpenStream(raw)
    if (this.sessions.size >= this.maxExtraStreams) throw new StreamSessionError('stream-limit')
    const id = this.id()
    if (!isExtraStreamId(id) || this.sessions.has(id)) throw new StreamSessionError('invalid-arguments')
    const runtime: Runtime = { revision: 0, view: { id, input: input.input, phase: 'opening', stream: null, buffer: null, error: null } }
    this.sessions.set(id, runtime)
    this.publish()
    return this.acquire(runtime, () => this.acquisition.resolve(input.input, input.platform, id, input.quality, input.preferAdaptive))
  }
  async switchQuality(id: StreamId, quality: string): Promise<StreamSessionView> {
    this.alive()
    if (typeof quality !== 'string' || !quality || quality.length > 128) throw new StreamSessionError('invalid-arguments')
    return this.acquire(this.require(id), () => this.acquisition.switchQuality(id, quality))
  }
  async restart(id: StreamId): Promise<StreamSessionView> {
    this.alive()
    return this.acquire(this.require(id), () => this.acquisition.restart(id))
  }
  describe(id: StreamId): ResolvedStream | null {
    if (!isStreamId(id) || this.disposed) return null
    return this.acquisition.describe(id)
  }
  async close(id: StreamId): Promise<StreamSessionsSnapshot> {
    this.alive()
    const runtime = this.require(id)
    ++runtime.revision
    this.sessions.delete(id)
    this.publish()
    await this.acquisition.stop(id)
    return this.snapshot()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.release()
    const ids = [...this.sessions.keys()]
    for (const runtime of this.sessions.values()) ++runtime.revision
    this.sessions.clear()
    this.listeners.clear()
    await Promise.all(ids.map(id => this.acquisition.stop(id)))
  }
  private async acquire(runtime: Runtime, operation: () => Promise<ResolveResult>): Promise<StreamSessionView> {
    const revision = ++runtime.revision
    runtime.view.phase = 'opening'
    runtime.view.error = null
    this.publish()
    let result: ResolveResult
    try { result = await operation() }
    catch { result = { ok: false, failure: { code: 'upstream-error', message: '取流失败, 请检查来源和本机工具' } } }
    if (this.disposed || this.sessions.get(runtime.view.id) !== runtime || runtime.revision !== revision) throw new StreamSessionError('stream-cancelled')
    if (result.ok) { runtime.view.stream = structuredClone(result.stream); runtime.view.phase = 'ready' }
    else { runtime.view.phase = 'failed'; runtime.view.error = result.failure.message }
    this.publish()
    return structuredClone(runtime.view)
  }
  private require(id: StreamId): Runtime {
    if (!isExtraStreamId(id)) throw new StreamSessionError('invalid-arguments')
    const value = this.sessions.get(id)
    if (!value) throw new StreamSessionError('stream-not-found')
    return value
  }
  private alive(): void { if (this.disposed) throw new StreamSessionError('disposed') }
  private publish(): void {
    for (const listener of this.listeners) { try { listener(this.snapshot()) } catch { /* Isolate renderer observers. */ } }
  }
}

export function readOpenStream(raw: unknown): OpenStreamInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StreamSessionError('invalid-arguments')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(k => !['input', 'platform', 'quality', 'preferAdaptive'].includes(k))
    || typeof value.input !== 'string' || !value.input.trim() || value.input.length > 8192
    || (value.platform !== undefined && !['youtube', 'twitch', 'douyu', 'bilibili', 'huya', 'direct'].includes(String(value.platform)))
    || (value.quality !== undefined && (typeof value.quality !== 'string' || !value.quality || value.quality.length > 128))
    || (value.preferAdaptive !== undefined && typeof value.preferAdaptive !== 'boolean')) throw new StreamSessionError('invalid-arguments')
  return { input: value.input.trim(), ...(value.platform ? { platform: value.platform as PlatformKind } : {}),
    ...(value.quality ? { quality: value.quality as string } : {}), ...(value.preferAdaptive !== undefined ? { preferAdaptive: value.preferAdaptive as boolean } : {}) }
}
