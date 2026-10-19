/**
 * Framing the streamer camera: draw a rough box over a paused commentary frame, let the
 * program tighten it to the camera's own rectangle, adjust, save for this room.
 *
 * The frame is a still copied from the commentary element when the dialog opens, so the
 * box is drawn on a picture that holds still. Tightening samples a few more frames from the
 * live element over the next seconds — the camera edge is the line that stays put while
 * the game behind it moves, which a single frame cannot show.
 */

import { useEffect, useRef, useState } from 'react'
import { useSession } from '../app/SessionContext'
import type { RoiRect } from '../core/profileSchema'
import { RoiWindow } from './admin/RoiWindow'

type Phase = 'draw' | 'tightening' | 'review'

interface Props {
  initial: RoiRect | null
  onSave: (crop: RoiRect) => void
  onRemove: (() => void) | null
  onClose: () => void
  /** Injected in tests; the app uses the WASM core. */
  tighten?: (frames: Uint8Array, width: number, height: number, rough: RoiRect) => Promise<{ roi: RoiRect; found: boolean[] }>
}

const SAMPLE_FRAMES = 6
const SAMPLE_INTERVAL_MS = 500
/** Analysis width; the camera edge is a hard step and survives a downscale. */
const ANALYSIS_WIDTH = 960

export function CameraCropDialog({ initial, onSave, onRemove, onClose, tighten = tightenWithWasm }: Props): React.ReactNode {
  const session = useSession()
  const still = useRef<HTMLCanvasElement | null>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [roi, setRoi] = useState<RoiRect>(initial ?? { x: 0.02, y: 0.4, w: 0.16, h: 0.2 })
  const [phase, setPhase] = useState<Phase>(initial ? 'review' : 'draw')
  const [message, setMessage] = useState<string | null>(null)
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])

  useEffect(() => {
    const video = session.engine.element('commentary')
    const canvas = still.current
    if (!video?.videoWidth || !canvas) {
      setMessage('解说画面还没有出来，请先加载并播放解说源。')
      return
    }
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    setSize({ width: video.videoWidth, height: video.videoHeight })
  }, [session])

  const runTighten = async (): Promise<void> => {
    const video = session.engine.element('commentary')
    if (!video?.videoWidth) return
    setPhase('tightening')
    setMessage(null)
    const width = Math.min(ANALYSIS_WIDTH, video.videoWidth)
    const height = Math.round(width * video.videoHeight / video.videoWidth)
    const work = document.createElement('canvas')
    work.width = width
    work.height = height
    const context = work.getContext('2d', { willReadFrequently: true })
    if (!context) return
    const frames = new Uint8Array(width * height * SAMPLE_FRAMES)
    for (let n = 0; n < SAMPLE_FRAMES; n += 1) {
      if (cancelled.current) return
      context.drawImage(video, 0, 0, width, height)
      const rgba = context.getImageData(0, 0, width, height).data
      for (let i = 0, o = n * width * height; i < width * height; i += 1) {
        frames[o + i] = (rgba[i * 4]! * 77 + rgba[i * 4 + 1]! * 150 + rgba[i * 4 + 2]! * 29) >> 8
      }
      if (n + 1 < SAMPLE_FRAMES) await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
    }
    if (video.paused) setMessage('解说处于暂停状态，收紧只能依据静止画面，结果可能偏大。')
    try {
      const result = await tighten(frames, width, height, roi)
      if (cancelled.current) return
      setRoi(result.roi)
      const found = result.found.filter(Boolean).length
      setMessage(found === 0
        ? '没有找到摄像头的边框，保留了你框的范围，可以直接拖动微调。'
        : found < 4 ? `已收紧 ${found} 条边，其余保留你框的位置。` : '已收紧到摄像头画面，可以再拖动微调。')
    } catch {
      setMessage('自动收紧失败，保留了你框的范围。')
    }
    setPhase('review')
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
            <RoiWindow roi={roi} onChange={setRoi} videoWidth={size.width} videoHeight={size.height} hostRef={stage} />
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
