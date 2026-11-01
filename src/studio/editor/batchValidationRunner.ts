import { parseHudStylePack, HUD_FIELD_IDS, HUD_CUE_IDS, type HudStylePack } from '../../core/hudStylePack'
import { recognizeHudFrame, type HudFrameResult } from '../../core/hudWasm'
import { FrameGrabber, FULL_FRAME_ROI, type GrabbedFrame } from '../../recognition/frameGrabber'
import { analyzeValidationFrame, failureValidationRow } from './batchValidationAnalysis'
import { FIELD_LABELS } from './editorModel'
import { CUE_LABELS } from './cueModel'
import { MAX_VALIDATION_SAMPLES, type ValidationImage, type ValidationPreview, type ValidationRange, type ValidationRow, type ValidationRun } from './batchValidationTypes'

const FRAME_TIMEOUT = 15_000
export interface ValidationCapture {
  frameAt(at: number, signal: AbortSignal): Promise<GrabbedFrame>
  dispose(): void
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error('验收已停止.'))
    if (signal.aborted) { void work.catch(() => {}); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

export function validationSampleCount(range: ValidationRange, duration: number): number {
  if (![range.from, range.to, range.step, duration].every(Number.isFinite)
    || duration <= 0 || range.from < 0 || range.to > duration || range.to <= range.from
    || ![0.5, 1, 2, 5].includes(range.step)) throw new Error('请选择有效的录像区间和抽样间隔.')
  const count = Math.ceil((range.to - range.from) / range.step - 1e-9)
  if (count < 1 || count > MAX_VALIDATION_SAMPLES) throw new Error(`一次最多抽样 ${MAX_VALIDATION_SAMPLES} 帧, 请缩短区间或增大间隔.`)
  return count
}

/** Wait for decode/seek completion, not merely a new requested currentTime. */
export function waitValidationVideo(video: HTMLVideoElement, at: number, signal: AbortSignal, timeout = FRAME_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let requested = false
    let seeking = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      for (const event of events) video.removeEventListener(event, check)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    const aborted = (): void => finish(signal.reason ?? new Error('验收已停止.'))
    const failed = (): void => finish(new Error('录像解码失败.'))
    const check = (event?: Event): void => {
      if (settled) return
      if (signal.aborted) { aborted(); return }
      if (video.error) { failed(); return }
      if (event?.type === 'seeked') seeking = false
      if (!requested && video.readyState >= 1) {
        requested = true
        seeking = video.seeking || Math.abs(video.currentTime - at) > 1e-6
        if (seeking) {
          try { video.currentTime = at } catch (error) { finish(error); return }
        }
      }
      if (requested && !seeking && !video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish()
    }
    for (const event of events) video.addEventListener(event, check)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => finish(new Error(`等待 ${at.toFixed(2)}s 的录像画面超时.`)), timeout)
    check()
  })
}

/** A separate decoder cannot seek, play, or teach through the editor's video handlers. */
export function createValidationCapture(source: string): ValidationCapture {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('aria-hidden', 'true')
  video.className = 'validation-decoder'
  video.style.cssText = 'position:fixed;width:1px;height:1px;left:0;bottom:0;opacity:0;pointer-events:none'
  video.src = source
  document.body.append(video)
  const grabber = new FrameGrabber()
  let disposed = false
  video.load()
  return {
    async frameAt(at, signal) {
      signal.throwIfAborted()
      if (disposed) throw new Error('验收录像已释放.')
      await waitValidationVideo(video, at, signal)
      signal.throwIfAborted()
      const grabbed = grabber.grab(video, FULL_FRAME_ROI, at)
      if (!grabbed.ok) throw new Error(`取帧失败: ${grabbed.reason}`)
      return grabbed.frame
    },
    dispose() {
      if (disposed) return
      disposed = true
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
      grabber.dispose()
    },
  }
}

interface SessionOptions {
  source: string
  sourceName: string
  pack: HudStylePack
  range: ValidationRange
  duration: number
  capture?: (source: string) => ValidationCapture
  recognize?: (frame: GrabbedFrame, pack: HudStylePack) => Promise<HudFrameResult>
}

/** This snapshot and its compact results live only for the current editor session. */
export class BatchValidationSession {
  readonly run: ValidationRun
  readonly rows: ValidationRow[] = []
  private readonly pack: HudStylePack
  private scanned = false

  constructor(private readonly options: SessionOptions) {
    const total = validationSampleCount(options.range, options.duration)
    const parsed = parseHudStylePack(options.pack)
    if (!parsed.pack) throw new Error(`样式包格式无效: ${parsed.issues[0]?.message ?? '请检查配置'}`)
    this.pack = structuredClone(parsed.pack)
    this.run = { ...options.range, total, sourceName: options.sourceName, packId: this.pack.id, packName: this.pack.name, packRevision: this.pack.revision }
  }

  async scan(signal: AbortSignal, progress: () => void): Promise<void> {
    if (this.scanned) throw new Error('请开始新的验收, 不重复使用已扫描的快照.')
    this.scanned = true
    signal.throwIfAborted()
    const capture = (this.options.capture ?? createValidationCapture)(this.options.source)
    let infrastructureFailures = 0
    try {
      for (let index = 0; index < this.run.total; index++) {
        signal.throwIfAborted()
        const at = this.run.from + index * this.run.step
        try {
          const frame = await abortable(capture.frameAt(at, signal), signal)
          signal.throwIfAborted()
          // Empty variantId is deliberate: test the player's automatic layout selection.
          const result = await abortable((this.options.recognize ?? recognizeHudFrame)(frame, this.pack), signal)
          signal.throwIfAborted()
          this.rows.push(analyzeValidationFrame(result, this.pack, frame.mediaTime, index, this.rows.at(-1) ?? null))
          infrastructureFailures = 0
        } catch (error) {
          if (signal.aborted) throw error
          this.rows.push(failureValidationRow(at, index, error instanceof Error ? error.message : String(error)))
          infrastructureFailures++
        }
        progress()
        if (infrastructureFailures >= 3) throw new Error('连续 3 次取帧或识别引擎调用失败, 已停止并保留结果. 普通识别失败和低置信度不会中止验收.')
        // Let stop clicks and painting run between CPU-bound WASM calls.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    } finally { capture.dispose() }
  }

  async inspect(index: number, signal: AbortSignal): Promise<ValidationPreview> {
    const row = this.rows[index]
    if (!row) throw new Error('没有对应的验收记录.')
    signal.throwIfAborted()
    const capture = (this.options.capture ?? createValidationCapture)(this.options.source)
    try {
      const frame = await abortable(capture.frameAt(row.at, signal), signal)
      signal.throwIfAborted()
      return { index, at: row.at, images: validationImages(frame, this.pack, row.layout) }
    } finally { capture.dispose() }
  }
}

/** Only the selected row gets display-size RGB crops; thousands of full frames stay out of RAM. */
export function validationImages(frame: GrabbedFrame, pack: HudStylePack, layout: string | null): ValidationImage[] {
  const source = document.createElement('canvas')
  source.width = frame.width
  source.height = frame.height
  const context = source.getContext('2d')
  if (!context) throw new Error('无法创建验收预览画布.')
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0)
  const images: ValidationImage[] = []
  const crop = (target: ValidationImage['target'], label: string, roi: { x: number; y: number; w: number; h: number }, max: number): void => {
    if (roi.x < 0 || roi.y < 0 || roi.w <= 0 || roi.h <= 0 || roi.x + roi.w > frame.width || roi.y + roi.h > frame.height) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, max / roi.w, 360 / roi.h)
    canvas.width = Math.max(1, Math.round(roi.w * scale))
    canvas.height = Math.max(1, Math.round(roi.h * scale))
    const paint = canvas.getContext('2d')
    if (!paint) throw new Error('无法创建验收裁切画布.')
    paint.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, canvas.width, canvas.height)
    images.push({ target, label, url: canvas.toDataURL('image/png'), width: roi.w, height: roi.h })
  }
  crop('frame', '原始整帧', { x: 0, y: 0, w: frame.width, h: frame.height }, 640)
  const variant = pack.variants.find(item => item.id === layout && item.nativeSize.width === frame.width && item.nativeSize.height === frame.height)
  if (variant) {
    for (const id of HUD_FIELD_IDS) {
      const field = variant.fields[id]
      if (field?.enabled) crop(id, FIELD_LABELS[id], field.roi, 512)
    }
    for (const id of [...HUD_CUE_IDS, 'organizer' as const]) {
      const cue = id === 'organizer' ? variant.organizer : variant.cues[id]
      if (cue?.enabled) crop(id, CUE_LABELS[id], cue.roi, 512)
    }
  }
  return images
}
