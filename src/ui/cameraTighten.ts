import type { RoiRect } from '../core/profileSchema'
import type { CameraSample } from './cameraFrames'

export interface CameraTightenResult { roi: RoiRect; found: [boolean, boolean, boolean, boolean]; ambiguous: boolean }

/** A temporary worker keeps expensive candidate comparisons off the playback/UI thread. */
export function tightenCamera(sample: CameraSample, signal: AbortSignal): Promise<CameraTightenResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cameraTighten.worker.ts', import.meta.url), { type: 'module', name: 'camera-boundary' })
    let settled = false
    const finish = (error?: Error, value?: CameraTightenResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(value!)
    }
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('贴边分析超时, 选框未改动. 请缩小粗选范围后重试.')), 12_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => {
      try {
        if (event.data?.ok !== true) throw new Error()
        const result = parseCameraTightenResult(event.data.value, sample)
        finish(undefined, result)
      } catch { finish(new Error('贴边分析失败, 选框未改动.')) }
    }
    worker.onerror = () => finish(new Error('贴边分析失败, 选框未改动.'))
    try { worker.postMessage(sample, [sample.frames.buffer]) } catch { finish(new Error('无法启动贴边分析, 选框未改动.')) }
  })
}

export function parseCameraTightenResult(value: unknown, sample: Pick<CameraSample, 'region' | 'rough'>): CameraTightenResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid camera result')
  const result = value as Partial<CameraTightenResult>
  const r = result.roi, rough = sample.rough
  if (!r || !Array.isArray(result.found) || result.found.length !== 4 || result.found.some(v => typeof v !== 'boolean')
    || typeof result.ambiguous !== 'boolean' || ![r.x, r.y, r.w, r.h].every(Number.isFinite)
    || r.w <= 0 || r.h <= 0 || r.x < rough.x - 1e-9 || r.y < rough.y - 1e-9
    || r.x + r.w > rough.x + rough.w + 1e-9 || r.y + r.h > rough.y + rough.h + 1e-9) throw new Error('Invalid camera result')
  const { region } = sample
  return { roi: { x: region.x + r.x * region.w, y: region.y + r.y * region.h, w: r.w * region.w, h: r.h * region.h },
    found: [...result.found] as CameraTightenResult['found'], ambiguous: result.ambiguous }
}
