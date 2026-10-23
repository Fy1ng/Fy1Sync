/**
 * Framing the streamer camera: draw a rough box over the existing commentary picture, let the
 * program tighten it to the camera's own rectangle, adjust, save for this room.
 *
 * Preview and analysis observe the MediaEngine element without changing its playback.
 */

import { useEffect, useRef, useState } from 'react'
import { useSession } from '../app/SessionContext'
import type { RoiRect } from '../core/profileSchema'
import { RoiWindow } from './admin/RoiWindow'
import { sampleCameraFrames, watchCameraFrames } from './cameraFrames'

type Phase = 'draw' | 'tightening' | 'review'

interface Props {
  initial: RoiRect | null
  onSave: (crop: RoiRect) => void
  onRemove: (() => void) | null
  onClose: () => void
  /** Injected in tests; the app uses the WASM core. */
  tighten?: (frames: Uint8Array, width: number, height: number, rough: RoiRect) => Promise<{ roi: RoiRect; found: boolean[] }>
}

export function CameraCropDialog({ initial, onSave, onRemove, onClose, tighten = tightenWithWasm }: Props): React.ReactNode {
  const session = useSession()
  const still = useRef<HTMLCanvasElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [roi, setRoi] = useState<RoiRect>(initial ?? { x: 0.02, y: 0.4, w: 0.16, h: 0.2 })
  const [phase, setPhase] = useState<Phase>(initial ? 'review' : 'draw')
  const [message, setMessage] = useState<string | null>(null)
  const mounted = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [])

  useEffect(() => {
    const video = session.engine.element('commentary')
    const canvas = still.current
    if (!video || !canvas) return
    let lastPaint = Number.NEGATIVE_INFINITY
    let lastWidth = 0, lastHeight = 0
    const stop = watchCameraFrames(video, () => {
      const { videoWidth: width, videoHeight: height } = video
      const changed = width !== lastWidth || height !== lastHeight
      // Limit preview work on high-resolution / high-frame-rate streams. ROI uses original
      // picture dimensions, while object-fit: contain maps this bounded canvas identically.
      if (!changed && !video.paused && !video.seeking && performance.now() - lastPaint < 60) return
      const previewWidth = Math.min(960, width), previewHeight = Math.max(1, Math.round(previewWidth * height / width))
      if (canvas.width !== previewWidth || canvas.height !== previewHeight) { canvas.width = previewWidth; canvas.height = previewHeight }
      try {
        canvas.getContext('2d')?.drawImage(video, 0, 0, previewWidth, previewHeight)
        lastPaint = performance.now()
        if (changed) { lastWidth = width; lastHeight = height; setSize({ width, height }); setMessage(null) }
      } catch { setMessage('暂时无法显示解说预览. 请等待画面恢复后重试.') }
    })
    const reset = (): void => {
      pending.current?.abort()
      pending.current = null
      setPhase('draw')
      setSize({ width: 0, height: 0 })
      setMessage('解说源正在加载. 画面恢复后可以继续取景.')
      lastWidth = lastHeight = 0
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    }
    video.addEventListener('emptied', reset)
    video.addEventListener('loadstart', reset)
    return () => { stop(); video.removeEventListener('emptied', reset); video.removeEventListener('loadstart', reset) }
  }, [session])

  const changeRoi = (next: RoiRect): void => {
    pending.current?.abort()
    pending.current = null
    setRoi(next)
    setPhase(current => current === 'tightening' ? 'review' : current)
    setMessage(null)
  }

  const runTighten = async (): Promise<void> => {
    const video = session.engine.element('commentary')
    if (!video || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    const rough = roi
    setPhase('tightening')
    setMessage(null)
    const interrupt = (): void => {
      controller.abort()
      if (mounted.current && pending.current === controller) {
        pending.current = null
        setPhase('review')
        setMessage('解说播放状态或画面发生变化. 请等待画面稳定后重新收紧.')
      }
    }
    const events = ['pause', 'seeking', 'resize', 'emptied', 'loadstart', 'error', 'ended'] as const
    events.forEach(event => video.addEventListener(event, interrupt))
    try {
      const { frames, width, height } = await sampleCameraFrames(video, controller.signal)
      const result = await tighten(frames, width, height, rough)
      if (!mounted.current || controller.signal.aborted) return
      const edges = (r: RoiRect): number[] => [r.x * width, r.y * height, (r.x + r.w) * width, (r.y + r.h) * height]
      const before = edges(rough), after = edges(result.roi)
      const valid = after.every(Number.isFinite) && after[0]! >= before[0]! - 0.01 && after[1]! >= before[1]! - 0.01 && after[2]! <= before[2]! + 0.01 && after[3]! <= before[3]! + 0.01 && after[2]! > after[0]! && after[3]! > after[1]!
      if (!valid) throw new Error('自动收紧返回了无效边界. 保留原取景框, 可以手动调整后重试.')
      const found = result.found.filter((value, i) => value && Math.abs(after[i]! - before[i]!) >= 0.5).length
      if (found > 0) setRoi(result.roi)
      setMessage(found === 0
        ? '没有找到可可靠收紧的摄像头边框. 保留原取景框, 可以直接拖动微调.'
        : found < 4 ? `已收紧 ${found} 条边. 请检查其余边并按需微调.` : '已收紧 4 条边. 请检查是否贴合摄像头, 可继续微调.')
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : '自动收紧失败. 保留原取景框, 可以重试或手动调整.')
    } finally {
      events.forEach(event => video.removeEventListener(event, interrupt))
      if (mounted.current && pending.current === controller) { pending.current = null; setPhase('review') }
    }
  }

  return (
    <div className="dialog-backdrop" onPointerDown={onClose}>
      <div className="dialog camera-dialog" role="dialog" aria-modal="true" aria-label="摄像头小窗取景" onPointerDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <h2>摄像头小窗取景</h2>
          <button type="button" className="ghost small" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <p className="camera-dialog-step">
          {phase === 'draw' ? '1. 在解说画面上框出主播摄像头的大致范围，框大一点没关系。'
            : phase === 'tightening' ? '2. 正在比对几帧画面，找摄像头的边框……'
              : '3. 检查框线是否贴住摄像头，可拖动边角微调，然后保存。'}
        </p>
        <div className="camera-dialog-stage" ref={stage}>
          <canvas ref={still} className="camera-dialog-still" />
          {size.width > 0 && (
            <RoiWindow roi={roi} onChange={changeRoi} videoWidth={size.width} videoHeight={size.height} hostRef={stage} />
          )}
        </div>
        {message && <p className="camera-dialog-message" role="status">{message}</p>}
        <footer className="dialog-footer">
          {onRemove && <button type="button" className="ghost danger camera-remove" onClick={onRemove}>删除此房间的小窗</button>}
          <span className="dialog-footer-spacer" />
          <button type="button" onClick={() => void runTighten()} disabled={size.width === 0 || phase === 'tightening'}>
            {phase === 'draw' ? '自动收紧' : '重新收紧'}
          </button>
          <button type="button" className="primary" onClick={() => onSave(roi)} disabled={size.width === 0 || phase === 'tightening'}>
            保存并显示
          </button>
        </footer>
      </div>
    </div>
  )
}

async function tightenWithWasm(frames: Uint8Array, width: number, height: number, rough: RoiRect): Promise<{ roi: RoiRect; found: boolean[] }> {
  const { loadCameraTighten } = await import('../wasm/load')
  return JSON.parse((await loadCameraTighten())(frames, width, height, JSON.stringify(rough))) as { roi: RoiRect; found: boolean[] }
}
