import type { Rect } from '../core/imageOps'
import type { RecognitionFailure } from '../core/types'

export interface ReadbackRequest {
  id: number
  source: ImageBitmap
  rect: Rect
  width: number
  height: number
}

export type ReadbackResponse = { id: number } & (
  | { ok: true; pixels: Uint8ClampedArray<ArrayBuffer> }
  | { ok: false; reason: RecognitionFailure; detail: string }
)

export function readbackFailure(error: unknown, readingPixels = false): {
  ok: false; reason: RecognitionFailure; detail: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const security = (error instanceof Error && error.name === 'SecurityError') || /secur|taint|cross.origin/iu.test(message)
  return {
    ok: false,
    reason: security || readingPixels ? 'canvas-tainted' : 'decode-failed',
    detail: security ? '画布被跨域视频污染，无法读取像素。请通过本地代理加载该源。' : message,
  }
}

/** Worker-owned canvases retain the same sRGB draw/resize path as the synchronous grabber. */
export class FrameReadback {
  private readonly targets = new Map<string, { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }>()

  read(request: ReadbackRequest): ReadbackResponse {
    const { id, source, rect, width, height } = request
    let target: { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
    try {
      const key = `${width}x${height}`
      let cached = this.targets.get(key)
      if (!cached) {
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
        if (!context) throw new Error('无法创建 2D 画布')
        cached = { canvas, context }
      }
      this.targets.delete(key)
      this.targets.set(key, cached)
      if (this.targets.size > 4) this.targets.delete(this.targets.keys().next().value!)
      target = cached
      target.context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height)
    } catch (error) {
      // A tainted canvas must not poison a subsequent origin-clean source of the same size.
      this.targets.clear()
      return { id, ...readbackFailure(error) }
    } finally {
      // Release the transferred video surface before the potentially blocking GPU readback.
      source.close()
    }
    try {
      return { id, ok: true, pixels: target.context.getImageData(0, 0, width, height).data }
    } catch (error) {
      this.targets.clear()
      return { id, ...readbackFailure(error, true) }
    }
  }
}
