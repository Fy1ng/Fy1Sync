import type { FrameMessage } from './protocol'
import type { ScorePixels, ScoreReading } from './score'

export function clockPixels(request: FrameMessage): { pixels: Uint8Array; width: number; height: number } {
  const input = new Uint8Array(request.pixels)
  if (input.length < request.width * request.height * 4) throw new Error('帧数据长度不足')
  const rect = request.score?.clockRect
  if (!rect) return { pixels: input, width: request.width, height: request.height }
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.x < 0 || rect.y < 0
    || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > request.width || rect.y + rect.height > request.height) {
    throw new Error('倒计时裁片范围无效')
  }
  const pixels = new Uint8Array(rect.width * rect.height * 4)
  for (let row = 0; row < rect.height; row += 1) {
    const start = ((rect.y + row) * request.width + rect.x) * 4
    pixels.set(input.subarray(start, start + rect.width * 4), row * rect.width * 4)
  }
  return { pixels, width: rect.width, height: rect.height }
}

export function scoreReading(request: FrameMessage, value: ScorePixels): ScoreReading | undefined {
  if (!request.score) return undefined
  return { ...value, source: request.score.source, generation: request.score.generation,
    width: request.score.width, height: request.score.height, segment: request.score.segment,
    mediaTime: request.mediaTime, wallTime: request.wallTime, frameIndex: request.frameIndex }
}
