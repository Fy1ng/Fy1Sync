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
import { tightenCamera } from '../ui/cameraTighten'
import { Sheet } from './kit'

export function CameraFraming({ initial, onSave, onRemove, onClose }: {
  initial: RoiRect | null
  onSave: (crop: RoiRect) => void
  onRemove: (() => void) | null
  onClose: () => void
}): React.ReactNode {
  const session = useSession()
  // A callback ref: Sheet mounts its content only after the dialog opens, a commit after this
  // component's own, so the canvas is not there yet when an effect on mount would run.
  const [still, setStill] = useState<HTMLCanvasElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [roi, setRoi] = useState<RoiRect>(initial ?? { x: 0.02, y: 0.4, w: 0.16, h: 0.2 })
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [previous, setPrevious] = useState<RoiRect | null>(null)
  const mounted = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; pending.current?.abort() }
  }, [])

  useEffect(() => {
    const video = session.engine.element('commentary')
    const canvas = still
    if (!video || !canvas) return
    let lastPaint = Number.NEGATIVE_INFINITY
    let lastWidth = 0
    let lastHeight = 0
    setMessage('正在等待解说画面就绪...')
    const stop = watchCameraFrames(video, () => {
      const { videoWidth: width, videoHeight: height } = video
      const changed = width !== lastWidth || height !== lastHeight
      if (!changed && !video.paused && !video.seeking && performance.now() - lastPaint < 60) return
      const w = Math.min(960, width)
      const h = Math.max(1, Math.round(w * height / width))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      try {
        const context = canvas.getContext('2d')
        if (!context) throw new Error('Preview context unavailable')
        context.drawImage(video, 0, 0, w, h)
        lastPaint = performance.now()
        if (changed) { lastWidth = width; lastHeight = height; setSize({ width, height }); setPrevious(null); setMessage(null) }
      } catch { setMessage('暂时无法读取解说画面，请在画面恢复后重试') }
    }, { previewFallback: true })
    const reset = (): void => {
      pending.current?.abort()
      pending.current = null
      setWorking(false)
      setSize({ width: 0, height: 0 })
      setPrevious(null)
      lastWidth = lastHeight = 0
      setMessage('解说正在重新载入')
    }
    video.addEventListener('emptied', reset)
    video.addEventListener('loadstart', reset)
    return () => { stop(); video.removeEventListener('emptied', reset); video.removeEventListener('loadstart', reset) }
  }, [session, still])

  const change = (next: RoiRect): void => {
    pending.current?.abort()
    pending.current = null
    setWorking(false)
    setRoi(next)
    setPrevious(null)
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
        setMessage('画面已变化, 请在稳定后重新贴边.')
      }
    }
    const events = ['pause', 'seeking', 'resize', 'emptied', 'loadstart', 'error', 'ended'] as const
    events.forEach((event) => video.addEventListener(event, interrupt))
    try {
      const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight
      const sample = await sampleCameraFrames(video, rough, controller.signal)
      const result = await tightenCamera(sample, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (result.ambiguous) { setMessage('检测到多个相近边界, 选框未改动. 请缩小粗选范围, 尽量排除比分板或字幕后重试.'); return }
      const edges = (r: RoiRect): number[] => [r.x * sourceWidth, r.y * sourceHeight, (r.x + r.w) * sourceWidth, (r.y + r.h) * sourceHeight]
      const before = edges(rough)
      const after = edges(result.roi)
      // The result may only shrink the box the viewer drew; anything else is discarded.
      const inside = after.every(Number.isFinite) && after[0]! >= before[0]! - 0.01 && after[1]! >= before[1]! - 0.01
        && after[2]! <= before[2]! + 0.01 && after[3]! <= before[3]! + 0.01 && after[2]! > after[0]! && after[3]! > after[1]!
      const moved = inside ? result.found.filter((value, i) => value && Math.abs(after[i]! - before[i]!) >= 0.5).length : 0
      if (moved > 0) { setPrevious(rough); setRoi(result.roi) }
      setMessage(moved === 0 ? '未识别到可靠边界, 选框未改动, 可手动调整.' : moved < 4 ? `已贴合 ${moved} 条边, 其余请手动调整.` : '四条边均已贴合, 请预览确认后保存.')
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setMessage(error instanceof Error ? error.message : '贴边失败, 选框未改动.')
    } finally {
      events.forEach((event) => video.removeEventListener(event, interrupt))
      if (mounted.current && pending.current === controller) { pending.current = null; setWorking(false) }
    }
  }

  return (
    <Sheet title="摄像头小窗" onClose={onClose} wide>
      <div className="framing">
        <p className="muted">框住完整摄像头并略留外边距, 尽量排除字幕和比分板. 贴边使用约 2 秒连续彩色画面, 只向内收紧; 保存前可撤回.</p>
        <div className="framing-stage" ref={stage}>
          <canvas ref={setStill} className="framing-still" />
          {size.width > 0 && <RoiWindow roi={roi} onChange={change} videoWidth={size.width} videoHeight={size.height} hostRef={stage} />}
        </div>
        {message && <p className="muted" role="status">{message}</p>}
        <div className="row-split">
          {onRemove ? <button type="button" className="btn-quiet is-danger" onClick={onRemove}>不再显示此房间的小窗</button> : <span />}
          <span className="row-end">
            {previous && <button type="button" className="btn-quiet" disabled={working} onClick={() => { setRoi(previous); setPrevious(null); setMessage('已撤回本次贴边.'); }}>撤回贴边</button>}
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
