import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react'
import type { Rect } from '../../core/imageOps'
import type { RoiRect } from '../../core/profileSchema'
import { FIT_VIEW, fitScale, focusRoi, panView, pictureRect, zoomAt, type Size, type StageView } from './stageViewport'

export function EditorStage({ mediaSize, roi, resetKey, enabled, hidden, children }: {
  mediaSize: Size
  roi: RoiRect
  resetKey: string
  enabled: boolean
  hidden: boolean
  children: (rect: Rect) => ReactNode
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })
  const [stored, setStored] = useState({ key: resetKey, view: FIT_VIEW })
  const fit = fitScale(mediaSize, viewport)
  const view = stored.key === resetKey
    ? { ...stored.view, zoom: Math.min(stored.view.zoom, Math.max(1, 4 / (fit || 1))) } : FIT_VIEW
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; y: number; view: StageView; rect: Rect } | null>(null)
  const rect = pictureRect(mediaSize, viewport, view)
  const scale = fitScale(mediaSize, viewport) * view.zoom
  const ready = enabled && scale > 0
  const update = (next: StageView): void => setStored({ key: resetKey, view: next })
  const reset = (): void => { update(FIT_VIEW); drag.current = null; setPanning(false) }
  const latest = useRef({ mediaSize, viewport, view, ready, update })
  latest.current = { mediaSize, viewport, view, ready, update }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => setViewport({ width: host.clientWidth, height: host.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    // React's delegated wheel listener is passive, so use a local non-passive listener.
    const wheel = (event: WheelEvent): void => {
      const current = latest.current
      if (!current.ready) return
      event.preventDefault()
      if (drag.current || host.querySelector('.roi-window:active')) return
      const bounds = host.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.viewport.height : 1)
      current.update(zoomAt(current.mediaSize, current.viewport, current.view, Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.002),
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top }))
    }
    host.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); host.removeEventListener('wheel', wheel) }
  }, [])

  useEffect(() => { setStored({ key: resetKey, view: FIT_VIEW }); drag.current = null; setPanning(false) }, [resetKey])
  useEffect(() => { drag.current = null; setPanning(false) }, [hidden])

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as Element
    if (!ready || (event.button !== 0 && event.button !== 1)) return
    if (event.button === 0 && target.closest('.roi-window:not(.is-readonly)')) return
    if (event.button === 0 && view.zoom <= 1) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view, rect }
    setPanning(true)
  }
  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <>
    <div className={`editor-stage${view.zoom > 1 ? ' is-zoomed' : ''}${panning ? ' is-panning' : ''}`}
      ref={hostRef} hidden={hidden} tabIndex={-1} aria-label="编辑画面"
      onPointerDownCapture={beginPan}
      onPointerMove={event => {
        const origin = drag.current
        if (origin?.pointerId === event.pointerId) update(panView(origin.view, origin.rect, event.clientX - origin.x, event.clientY - origin.y))
      }}
      onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}
      onDoubleClick={event => { if (!(event.target as Element).closest('.roi-window:not(.is-readonly)')) reset() }}>
      {children(rect)}
    </div>
    <div className="editor-view-tools" hidden={hidden}>
      <button type="button" className="btn-quiet small" disabled={!ready} onClick={reset} title="双击画面空白处也可复位">适应窗口</button>
      <button type="button" className="btn-quiet small" disabled={!ready} onClick={() => update(focusRoi(mediaSize, viewport, roi))}>放大到当前框</button>
      <span className="editor-zoom-value num" aria-label="画面缩放">{!ready ? '--' : Math.abs(scale - 1) < 0.005 ? '1:1' : `${scale.toFixed(2)}x`}</span>
      <span className="muted">滚轮缩放 / 拖空白处或中键平移 / 双击空白处复位</span>
    </div>
  </>
}
