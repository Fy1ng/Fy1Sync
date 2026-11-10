/** Reusable source-relative region authoring with native pixels and editor zoom controls. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { contentRect, normalizeRoi, pointToFraction, type Rect } from '../core/imageOps'
import type { RoiRect } from '../core/profileSchema'
import { EditorStage } from './editor/EditorStage'
import { RoiWindow } from './editor/RoiWindow'
import { Sheet } from './kit'
import './BasicRegionSheet.css'

export interface BasicRegionSheetProps {
  video: HTMLVideoElement
  sourceToken: unknown
  initial: RoiRect | null
  title: string
  saveLabel: string
  onSave: (roi: RoiRect) => void
  onClose: () => void
  instructions: string
  label?: string
}

export function BasicRegionSheet({ video, sourceToken, initial, title, saveLabel, onSave, onClose, instructions, label = '官方画面当前帧' }: BasicRegionSheetProps): React.ReactNode {
  const latest = useRef({ video, sourceToken })
  latest.current = { video, sourceToken }
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [roi, setRoi] = useState<RoiRect>(initial ?? { x: 0, y: 0, w: 1, h: 1 })
  const [invalid, setInvalid] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const captured = useRef<{ video: HTMLVideoElement; token: unknown; source: string; object: HTMLVideoElement['srcObject']; width: number; height: number } | null>(null)
  const drag = useRef<{ pointerId: number; start: { x: number; y: number }; bounds: DOMRect; picture: Rect } | null>(null)
  const pendingPaint = useRef<number | null>(null)
  const stopPaint = (): void => {
    if (pendingPaint.current !== null) cancelAnimationFrame(pendingPaint.current)
    pendingPaint.current = null
  }
  const current = (): boolean => {
    const value = captured.current, active = latest.current.video
    return !!value && value.video === active && value.token === latest.current.sourceToken
      && value.source === (active.currentSrc || active.src || '') && value.object === active.srcObject
      && value.width === active.videoWidth && value.height === active.videoHeight && active.readyState >= 2
  }
  const capture = (): void => {
    if (!canvas) return
    stopPaint()
    const active = latest.current.video, width = active.videoWidth, height = active.videoHeight
    if (!width || !height || active.readyState < 2 || active.seeking) { setProblem('画面尚未就绪, 请等待后重新取帧.'); setInvalid(true); return }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 16_777_216) { setProblem('画面尺寸过大, 请换较低画质后重试.'); setInvalid(true); return }
    const token = latest.current.sourceToken, source = active.currentSrc || active.src || '', object = active.srcObject
    const deadline = performance.now() + 1000
    captured.current = null
    setInvalid(true)
    setProblem('正在读取当前画面...')
    const paint = (): void => {
      pendingPaint.current = null
      if (latest.current.video !== active || latest.current.sourceToken !== token
        || source !== (active.currentSrc || active.src || '') || object !== active.srcObject
        || active.videoWidth !== width || active.videoHeight !== height) {
        setProblem('片源已改变, 请重新取帧后框选.'); return
      }
      try {
        // Zoom uses the original frame pixels, never an enlarged low-resolution thumbnail.
        canvas.width = width; canvas.height = height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas unavailable')
        context.clearRect(0, 0, width, height)
        context.drawImage(active, 0, 0, width, height)
        // A decoded first frame may not yet be readable when a paused sample opens.
        if (context.getImageData(0, 0, 1, 1).data[3] === 0) {
          if (performance.now() < deadline) { pendingPaint.current = requestAnimationFrame(paint); return }
          throw new Error('Video frame unavailable')
        }
        captured.current = { video: active, token, source, object, width, height }
        setSize({ width, height }); setInvalid(false); setProblem(null); setDrawing(false); setRevision(value => value + 1)
      } catch { setInvalid(true); setProblem('无法读取当前画面, 请重新取帧.') }
    }
    paint()
  }
  useEffect(() => { capture(); return stopPaint }, [canvas])
  useEffect(() => {
    const invalidate = (): void => { stopPaint(); setInvalid(true); setDrawing(false); drag.current = null; setProblem('片源或画面尺寸已改变, 请重新取帧后框选.') }
    for (const event of ['emptied', 'loadstart', 'resize']) video.addEventListener(event, invalidate)
    return () => { for (const event of ['emptied', 'loadstart', 'resize']) video.removeEventListener(event, invalidate) }
  }, [video])
  useEffect(() => {
    if (captured.current && (captured.current.token !== sourceToken || captured.current.video !== video)) {
      setInvalid(true); setDrawing(false); drag.current = null; setProblem('片源已改变, 请重新取帧后框选.')
    }
  }, [video, sourceToken])
  const point = (event: ReactPointerEvent, value: NonNullable<typeof drag.current>) => pointToFraction({ x: event.clientX - value.bounds.left, y: event.clientY - value.bounds.top }, value.picture)
  const begin = (event: ReactPointerEvent<HTMLDivElement>, picture: Rect): void => {
    if (event.button !== 0 || invalid || !size.width || (!drawing && (event.target as Element).closest('.roi-window'))) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const fitted = contentRect(size.width, size.height, bounds.width, bounds.height)
    // EditorStage owns blank-space panning when zoomed; new drawing begins in fit view.
    if (!bounds.width || !bounds.height || Math.abs(picture.width - fitted.width) > 1) return
    const value = { pointerId: event.pointerId, start: { x: 0, y: 0 }, bounds, picture }
    const start = point(event, value)
    value.start = { x: Math.min(start.x, 1 - 1 / size.width), y: Math.min(start.y, 1 - 1 / size.height) }
    drag.current = value
    setRoi({ ...value.start, w: 1 / size.width, h: 1 / size.height })
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation()
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const value = drag.current
    if (!value || value.pointerId !== event.pointerId) return
    const end = point(event, value)
    setRoi(normalizeRoi({ x: Math.min(value.start.x, end.x), y: Math.min(value.start.y, end.y),
      w: Math.max(1 / size.width, Math.abs(end.x - value.start.x)), h: Math.max(1 / size.height, Math.abs(end.y - value.start.y)) }))
    event.stopPropagation()
  }
  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return
    move(event); drag.current = null; setDrawing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const save = (): void => {
    if (invalid || !current()) { setInvalid(true); setProblem('片源或画面尺寸已改变, 请重新取帧后框选.'); return }
    const selected = normalizeRoi(roi)
    if (selected.w <= 0 || selected.h <= 0) { setProblem('请框出至少一个像素的有效范围.'); return }
    onSave(selected)
    onClose()
  }
  return <Sheet title={title} onClose={onClose} wide>
    <div className="basic-region-sheet">
      <p className="basic-region-sheet__instructions">{instructions}</p>
      <p className="basic-region-sheet__instructions">适应窗口时可拖空白处画新框, 放大后拖动选框边角精调. 画面继续播放.</p>
      <div className="basic-region-sheet__stage-wrap">
        <EditorStage mediaSize={size} roi={roi} resetKey={`${title}/${revision}`} enabled={size.width > 0 && !invalid} hidden={false}>
          {picture => <div className={`basic-region-sheet__surface${drawing ? ' is-drawing' : ''}`}
            onPointerDown={event => begin(event, picture)} onPointerMove={move} onPointerUp={end}
            onPointerCancel={() => { drag.current = null; setDrawing(false) }}
            onLostPointerCapture={() => { drag.current = null; setDrawing(false) }}>
            <canvas ref={setCanvas} className="basic-region-sheet__still" aria-label={label}
              style={{ left: picture.x, top: picture.y, width: picture.width, height: picture.height }} />
            {size.width > 0 && <RoiWindow roi={roi} onChange={setRoi} videoWidth={size.width} videoHeight={size.height}
              contentBox={picture} readOnly={invalid || drawing} label="范围" />}
          </div>}
        </EditorStage>
      </div>
      {problem && <p className="basic-region-sheet__problem" role="status">{problem}</p>}
      <div className="basic-region-sheet__actions">
        <span>
          <button type="button" className="btn-quiet" onClick={capture}>重新取帧</button>
          <button type="button" className="btn-quiet" disabled={!size.width || invalid} onClick={() => { setRevision(value => value + 1); setDrawing(true) }}>重新绘制</button>
        </span>
        <span>
          <button type="button" className="btn-quiet" onClick={onClose}>取消</button>
          <button type="button" className="btn-solid" disabled={!size.width || invalid} onClick={save}>{saveLabel}</button>
        </span>
      </div>
    </div>
  </Sheet>
}
