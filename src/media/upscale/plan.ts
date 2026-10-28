/** Pure sizing and pass decisions, independent of the GPU and the video element. */
export type UpscaleTier = 'off' | 'performance' | 'quality'

export interface PixelCrop { x: number; y: number; width: number; height: number }
export interface OutputSize { width: number; height: number }
export type UpscalePass = 'crop' | 'bilinear' | 'cnn' | 'easu' | 'rcas'

export function outputSize(cssWidth: number, cssHeight: number, dpr: number, limit = 2560): OutputSize {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const width = Math.max(1, Math.round(Number.isFinite(cssWidth) ? cssWidth * ratio : 1))
  const height = Math.max(1, Math.round(Number.isFinite(cssHeight) ? cssHeight * ratio : 1))
  const scale = Math.min(1, limit / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function passPlan(tier: UpscaleTier, crop: OutputSize, output: OutputSize): { scale: number; passes: UpscalePass[] } {
  const scale = Math.max(output.width / Math.max(1, crop.width), output.height / Math.max(1, crop.height))
  if (tier === 'off') return { scale, passes: [] }
  if (scale <= 1) return { scale, passes: ['crop', 'bilinear'] }
  if (tier === 'quality' && scale > 1.2) {
    return { scale, passes: ['crop', 'cnn', ...(scale > 2 ? ['easu', 'rcas'] as const : ['bilinear'] as const)] }
  }
  return { scale, passes: ['crop', 'easu', 'rcas'] }
}
