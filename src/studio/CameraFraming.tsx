/**
 * Picking the streamer's camera out of the commentary picture so it can float over the
 * match. Draw a loose box; "贴边" lets the program find the camera's own edges inside it.
 *
 * The preview reads the live commentary element and never changes its playback.
 */

import { useEffect, useRef, useState } from 'react'
import { useSession } from '../app/SessionContext'
import type { RoiRect } from '../core/profileSchema'
import { RoiWindow } from './editor/RoiWindow'
import { sampleCameraFrames, watchCameraFrames } from '../ui/cameraFrames'
import { Sheet } from './kit'

export function CameraFraming({ initial, onSave, onRemove, onClose }: {
  initial: RoiRect | null
  onSave: (crop: RoiRect) => void
  onRemove: (() => void) | null
  onClose: () => void
}): React.ReactNode {
  const session = useSession()
  const still = useRef<HTMLCanvasElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [roi, setRoi] = useState<RoiRect>(initial ?? { x: 0.02, y: 0.4, w: 0.16, h: 0.2 })
  const [working, setWorking] = useState(false)
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
    let lastWidth = 0
    let lastHeight = 0
    const stop = watchCameraFrames(video, () => {
      const { videoWidth: width, videoHeight: height } = video
      const changed = width !== lastWidth || height !== lastHeight
      if (!changed && !video.paused && !video.seeking && performance.now() - lastPaint < 60) return
      const w = Math.min(960, width)
      const h = Math.max(1, Math.round(w * height / width))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      try {
        canvas.getContext('2d')?.drawImage(video, 0, 0, w, h)
        lastPaint = performance.now()
        if (changed) { lastWidth = width; lastHeight = height; setSize({ width, height }); setMessage(null) }
      } catch { setMessage('暂时无法读取解说画面，请在画面恢复后重试') }
    })
    const reset = (): void => {
      pending.current?.abort()
      pending.current = null
      setWorking(false)
      setSize({ width: 0, height: 0 })
      lastWidth = lastHeight = 0
      setMessage('解说正在重新载入')
    }
    video.addEventListener('emptied', reset)
    video.addEventListener('loadstart', reset)
    return () => { stop(); video.removeEventListener('emptied', reset); video.removeEventListener('loadstart', reset) }
  }, [session])

  const change = (next: RoiRect): void => {
    pending.current?.abort()
    pending.current = null
    setWorking(false)
    setRoi(next)
    setMessage(null)
  }

  const snap = async (): Promise<void> => {
    const video = session.engine.element('commentary')
    if (!video || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    const rough = roi
    setWorking(true)
    setMessage(null)
    const interrupt = (): void => {
      controller.abort()
      if (mounted.current && pending.current === controller) {
        pending.current = null
        setWorking(false)
        setMessage('画面已变化，请在稳定后重新贴边')
      }
    }
    const events = ['pause', 'seeking', 'resize', 'emptied', 'loadstart', 'error', 'ended'] as const
    events.forEach((event) => video.addEventListener(event, interrupt))
    try {
      const { frames, width, height } = await sampleCameraFrames(video, controller.signal)
      const { loadCameraTighten } = await import('../wasm/load')
      const result = JSON.parse((await loadCameraTighten())(frames, width, height, JSON.stringify(rough))) as { roi: RoiRect; found: boolean[] }
      if (!mounted.current || controller.signal.aborted) return
      const edges = (r: RoiRect): number[] => [r.x * width, r.y * height, (r.x + r.w) * width, (r.y + r.h) * height]
      const before = edges(rough)
      const after = edges(result.roi)
      // The result may only shrink the box the viewer drew; anything else is discarded.
      const inside = after.every(Number.isFinite) && after[0]! >= before[0]! - 0.01 && after[1]! >= before[1]! - 0.01
        && after[2]! <= before[2]! + 0.01 && after[3]! <= before[3]! + 0.01 && after[2]! > after[0]! && after[3]! > after[1]!
      const moved = inside ? result.found.filter((value, i) => value && Math.abs(after[i]! - before[i]!) >= 0.5).length : 0
      if (moved > 0) setRoi(result.roi)
      setMessage(moved === 0 ? '未识别到清晰的边框，选框未改动，可手动调整' : moved < 4 ? `已贴合 ${moved} 条边，其余请手动调整` : '四条边均已贴合')
    } catch {
      if (mounted.current && !controller.signal.aborted) setMessage('贴边失败，选框未改动')
    } finally {
      events.forEach((event) => video.removeEventListener(event, interrupt))
      if (mounted.current && pending.current === controller) { pending.current = null; setWorking(false) }
    }
  }

  return (
    <Sheet title="摄像头小窗" onClose={onClose} wide>
      <div className="framing">
        <p className="muted">在解说画面上框选主播摄像头区域，选框可略大于实际范围。</p>
        <div className="framing-stage" ref={stage}>
          <canvas ref={still} className="framing-still" />
          {size.width > 0 && <RoiWindow roi={roi} onChange={change} videoWidth={size.width} videoHeight={size.height} hostRef={stage} />}
        </div>
        {message && <p className="muted" role="status">{message}</p>}
        <div className="row-split">
          {onRemove ? <button type="button" className="btn-quiet is-danger" onClick={onRemove}>不再显示此房间的小窗</button> : <span />}
          <span className="row-end">
            <button type="button" className="btn-quiet" disabled={size.width === 0 || working} onClick={() => void snap()}>
              {working ? '正在贴边…' : '贴边'}
            </button>
            <button type="button" className="btn-solid" disabled={size.width === 0 || working} onClick={() => onSave(roi)}>保存</button>
          </span>
        </div>
      </div>
    </Sheet>
  )
}
