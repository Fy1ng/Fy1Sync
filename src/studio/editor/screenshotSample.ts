/**
 * Screenshot samples for the profile editor.
 *
 * A still image is a valid sample source as long as it is a real capture of the broadcast:
 * a screenshot from the player keeps the encoder's anti-aliasing, which is what the
 * "samples come from decoded frames" rule of the profile editor is about. Images are
 * decoded in the renderer from a Blob — no URL, no upload, no main-process involvement.
 */

import type { GrabbedFrame } from '../../recognition/frameGrabber'

export const SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024
export const MIN_SCREENSHOT_SIDE = 160
export const MAX_SCREENSHOT_SIDE = 7680

export type ScreenshotCheck = { ok: true } | { ok: false; message: string }

export function checkScreenshotFile(file: Pick<Blob, 'type' | 'size'>): ScreenshotCheck {
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, message: '截图只支持 PNG、JPEG 或 WebP' }
  }
  if (file.size === 0) return { ok: false, message: '截图文件是空的' }
  if (file.size > MAX_SCREENSHOT_BYTES) return { ok: false, message: '截图超过 25 MB' }
  return { ok: true }
}

export function checkScreenshotSize(width: number, height: number): ScreenshotCheck {
  if (Math.min(width, height) < MIN_SCREENSHOT_SIDE) {
    return { ok: false, message: `截图太小（${width}×${height}），请截完整画面` }
  }
  if (Math.max(width, height) > MAX_SCREENSHOT_SIDE) {
    return { ok: false, message: `截图太大（${width}×${height}），最长边不超过 ${MAX_SCREENSHOT_SIDE}` }
  }
  return { ok: true }
}

/** The first image on the clipboard, if any. */
export function imageFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && (SCREENSHOT_TYPES as readonly string[]).includes(item.type)) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

export type DecodedScreenshot = { ok: true; frame: GrabbedFrame } | { ok: false; message: string }

/** Decode to RGBA at native size; the same shape the video grabber produces. */
export async function decodeScreenshot(
  file: Blob,
  clock: () => number = () => Date.now(),
  decode: (blob: Blob) => Promise<ImageBitmap> = (blob) => createImageBitmap(blob),
): Promise<DecodedScreenshot> {
  const typed = checkScreenshotFile(file)
  if (!typed.ok) return typed
  let bitmap: ImageBitmap
  try {
    bitmap = await decode(file)
  } catch {
    return { ok: false, message: '无法解码这张截图' }
  }
  try {
    const sized = checkScreenshotSize(bitmap.width, bitmap.height)
    if (!sized.ok) return sized
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return { ok: false, message: '无法创建画布' }
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height)
    return { ok: true, frame: { pixels: image.data, width: image.width, height: image.height, mediaTime: 0, wallTime: clock() } }
  } finally {
    bitmap.close()
  }
}
