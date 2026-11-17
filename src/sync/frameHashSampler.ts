import { FrameGrabber, FULL_FRAME_ROI, startFrameLoop } from '../recognition/frameGrabber'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import type { FrameHashConfig, HashRequest, HashResponse } from './frameHashProtocol'
import type { OffsetEstimate } from '../core/offsetEstimator'

export interface FrameMeasurement {
  estimate?: OffsetEstimate; message?: string; samples: Record<SourceRole, number>
}
export interface FrameMeasureRequest {
  windowMs: number; appliedOffsetSeconds: number; fresh: boolean; signal: { readonly aborted: boolean }
}
interface Anchor { media: number; wall: number; rate: number; epoch: string }
interface SamplerOptions {
  video(role: SourceRole): HTMLVideoElement
  revision(role: SourceRole): string
  config(): FrameHashConfig
  onStatus(status: string): void
}
const REASONS: Record<string, string> = {
  'short-window': '正在积累两路画面', 'no-candidates': '尚未找到共同画面',
  'insufficient-sequence': '共同片段长度不足', 'ambiguous-sequence': '存在多个相似片段, 暂不调整',
  'static-sequence': '画面变化不足, 暂不调整', 'inconsistent-motion': '画面变化对应不稳定, 暂不调整',
}

/** Reuses the player's video surfaces; retains only bounded signatures in a worker. */
export class FrameHashSampler {
  private worker: Worker | null = null
  private readonly grabbers: Record<SourceRole, FrameGrabber> = {
    official: new FrameGrabber(() => performance.now()), commentary: new FrameGrabber(() => performance.now()),
  }
  private readonly stops: (() => void)[] = []
  private readonly epoch: Record<SourceRole, string> = { official: '', commentary: '' }
  private readonly inFlight = { official: false, commentary: false }
  private readonly lastCapture = { official: -Infinity, commentary: -Infinity }
  private readonly anchors: Partial<Record<SourceRole, Anchor>> = {}
  private pending: { id: number; resolve(value: Extract<HashResponse, { type: 'result' }> | null): void } | null = null
  private id = 0
  private active = false
  private disposed = false
  private error = ''

  constructor(private readonly options: SamplerOptions) {
    this.worker = new Worker(new URL('./frameHash.worker.ts', import.meta.url), { type: 'module', name: 'frame-matching' })
    this.worker.onmessage = (event: MessageEvent<HashResponse>) => {
      if (this.disposed) return
      const result = event.data
      if (result.type === 'ack') this.inFlight[result.role] = false
      else if (result.type === 'error') { this.error = result.message; this.options.onStatus(result.message); this.pending?.resolve(null) }
      else if (this.pending?.id === result.id) this.pending.resolve(result)
    }
    this.worker.onerror = () => { this.error = '画面匹配线程运行失败, 请切换模式后重试'; this.pending?.resolve(null); this.options.onStatus(this.error) }
    for (const role of SOURCE_ROLES) {
      const video = options.video(role)
      this.stops.push(startFrameLoop(video, 60, (media, timing) => {
        if (this.disposed || this.error) return
        const revision = options.revision(role)
        const epoch = `${revision}:${video.videoWidth}x${video.videoHeight}`
        if (epoch !== this.epoch[role]) this.invalidate(role, epoch)
        if (video.paused || video.seeking || video.ended || video.readyState < 3) return
        const wall = performance.now()
        const presented = timing ? wall + timing.expectedDisplayTime - timing.callbackTime : wall
        this.anchors[role] = { media, wall: presented, rate: video.playbackRate, epoch }
        const interval = this.active ? 0 : 1 / 15
        if (media - this.lastCapture[role] < interval || this.inFlight[role] || this.grabbers[role].busy) return
        this.lastCapture[role] = media
        const roi = options.config().regions[role] ?? FULL_FRAME_ROI
        void this.grabbers[role].grabScaledAsync(video, roi, 128, media).then(result => {
          if (!result.ok || this.disposed || this.epoch[role] !== epoch || video.seeking || video.paused) return
          this.inFlight[role] = true
          this.post({ type: 'frame', role, pts: media, wall: presented, epoch,
            width: result.frame.width, height: result.frame.height, pixels: result.frame.pixels,
            masks: options.config().masks }, [result.frame.pixels.buffer as ArrayBuffer])
        })
      }))
    }
    this.options.onStatus('正在积累共同画面, 无需倒计时样式包')
  }

  private post(message: HashRequest, transfer: Transferable[] = []): void { this.worker?.postMessage(message, transfer) }
  private invalidate(role: SourceRole, epoch: string): void {
    this.epoch[role] = epoch
    this.lastCapture[role] = -Infinity
    this.inFlight[role] = false
    delete this.anchors[role]
    this.grabbers[role].cancel()
    this.post({ type: 'reset', role })
    this.options.onStatus('画面时序已变化, 正在重新积累共同片段')
  }
  private playable(): boolean {
    return SOURCE_ROLES.every(role => {
      const video = this.options.video(role)
      return !video.paused && !video.seeking && !video.ended && video.readyState >= 3
    })
  }
  private query(fresh: boolean): Promise<Extract<HashResponse, { type: 'result' }> | null> {
    return new Promise(resolve => {
      const id = ++this.id
      const timer = setTimeout(() => finish(null), 5000)
      const finish = (value: Extract<HashResponse, { type: 'result' }> | null): void => {
        clearTimeout(timer)
        if (this.pending?.id === id) this.pending = null
        resolve(value)
      }
      this.pending = { id, resolve: finish }
      this.post({ type: 'match', id, fresh })
    })
  }

  async measure(request: FrameMeasureRequest): Promise<FrameMeasurement> {
    this.active = true
    const started = performance.now()
    const epochs = SOURCE_ROLES.map(role => this.options.revision(role))
    const samples = { official: 0, commentary: 0 }
    let message = '尚未取得足够的共同画面, 请继续播放后重试'
    if (request.fresh) this.post({ type: 'fresh', since: started })
    try {
      const duration = Math.max(request.windowMs, request.fresh ? 6000 : 9000)
      while (performance.now() - started < duration) {
        if (request.signal.aborted || this.disposed) return { samples, message: '画面匹配已取消' }
        if (!this.playable()) return { samples, message: '两路画面需要保持播放, 请等待缓冲完成后重试' }
        if (this.error) return { samples, message: this.error }
        await new Promise(resolve => setTimeout(resolve, 500))
        if (request.signal.aborted || this.disposed) return { samples, message: '画面匹配已取消' }
        if (SOURCE_ROLES.some((role, i) => this.options.revision(role) !== epochs[i])) {
          return { samples, message: '画面匹配期间发生换源或跳转, 请重试' }
        }
        const response = await this.query(request.fresh)
        if (!response || request.signal.aborted || this.disposed) continue
        Object.assign(samples, response.counts)
        const match = response.match
        if (match.status !== 'ok' || match.offset === undefined || (match.pairs?.length ?? 0) < 20
          || (match.span ?? 0) < 1.25 || (match.residual ?? Infinity) > (response.coarse ? 0.1 : 0.025)) {
          message = REASONS[match.reason ?? ''] ?? '未找到可靠的共同画面'
          this.options.onStatus(`${message}, 已采集 ${samples.official}/${samples.commentary} 帧`)
          continue
        }
        const a = this.anchors.official, b = this.anchors.commentary
        const wall = performance.now()
        if (!a || !b || wall - a.wall > 350 || wall - b.wall > 350 || !this.playable()
          || SOURCE_ROLES.some((role, i) => this.options.revision(role) !== epochs[i])) continue
        const currentA = a.media + (wall - a.wall) / 1000 * a.rate
        const currentB = b.media + (wall - b.wall) / 1000 * b.rate
        const residual = currentA - currentB - match.offset
        const total = request.appliedOffsetSeconds + residual
        if (!Number.isFinite(total) || Math.abs(total) > 60) return { samples, message: '两路画面偏差超出 60 秒可调整范围' }
        const round = (value: number): number => Math.round(value * 1000) / 1000
        this.options.onStatus(`已匹配 ${match.pairs!.length} 帧, 当前偏差 ${residual.toFixed(3)} 秒${response.coarse ? ', 校正后将精细复核' : ''}`)
        return { samples, estimate: {
          status: 'ok', residualSeconds: round(residual), totalOffsetSeconds: round(total),
          direction: Math.abs(total) <= 0.1 ? 'none' : total > 0 ? 'official' : 'commentary',
          rewindSeconds: Math.abs(total) <= 0.1 ? 0 : round(Math.abs(total)), confidence: match.confidence ?? 0,
          officialAnchorSpread: match.residual ?? 0, commentaryAnchorSpread: match.residual ?? 0,
          officialEvents: match.pairs!.length, commentaryEvents: match.pairs!.length,
        } }
      }
      return { samples, message }
    } finally { this.active = false }
  }

  dispose(): void {
    this.disposed = true
    for (const stop of this.stops) stop()
    for (const role of SOURCE_ROLES) this.grabbers[role].dispose()
    this.pending?.resolve(null)
    this.worker?.terminate()
    this.worker = null
  }
}
