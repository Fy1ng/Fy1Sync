import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { contentRect, normalizeRoi, pointToFraction, roiToPixels, type Rect } from '../core/imageOps'
import type { RoiRect } from '../core/profileSchema'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { watchCameraFrames } from '../ui/cameraFrames'
import { RoiWindow } from '../ui/regions/RoiWindow'
import { Icon, Segmented } from './kit'
import './FrameHashSettings.css'

const FULL: RoiRect = { x: 0, y: 0, w: 1, h: 1 }
const MAX_MASKS = 8
const MIN_BOX = 0.02
const DRAG_THRESHOLD_PX = 4
const FALLBACK_VIDEO = { width: 1920, height: 1080 }

type EditStep = 'crop' | 'mask'

export function isFullRegion(roi: RoiRect): boolean {
  return Math.abs(roi.x) < 0.005 && Math.abs(roi.y) < 0.005
    && Math.abs(roi.w - 1) < 0.005 && Math.abs(roi.h - 1) < 0.005
}

/** Exact visible fraction on the 64x36 detail grid used by `frameHashCore.mjs`. */
export function visibleFrameFraction(masks: readonly RoiRect[]): number {
  if (masks.length === 0) return 1
  const width = 128
  const height = 72
  let visible = 0
  let total = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      total += 1
      const masked = masks.some(r =>
        x >= r.x * width && y >= r.y * height && x < (r.x + r.w) * width && y < (r.y + r.h) * height)
      if (!masked) visible += 1
    }
  }
  return visible / total
}

function formatRegionSummary(roi: RoiRect): string {
  if (isFullRegion(roi)) return '完整画面'
  return `${Math.round(roi.w * 100)}%×${Math.round(roi.h * 100)}%（左 ${Math.round(roi.x * 100)}%，顶 ${Math.round(roi.y * 100)}%）`
}

function clampBox(roi: RoiRect): RoiRect {
  const normalized = normalizeRoi(roi)
  const w = Math.max(MIN_BOX, normalized.w)
  const h = Math.max(MIN_BOX, normalized.h)
  return {
    x: Math.min(Math.max(0, normalized.x), 1 - w),
    y: Math.min(Math.max(0, normalized.y), 1 - h),
    w: Math.min(1, w),
    h: Math.min(1, h),
  }
}

function RegionNumbers({ label, value, onChange }: {
  label: string
  value: RoiRect
  onChange(value: RoiRect): void
}): React.ReactNode {
  return (
    <fieldset className="field-stack">
      <legend>{label}</legend>
      <div className="fh-number-grid">
        {([['x', '左侧'], ['y', '顶部'], ['w', '宽度'], ['h', '高度']] as const).map(([key, title]) => (
          <label className="field-stack" key={key}>
            <span className="muted">{title} %</span>
            <input
              type="number"
              className="text-input"
              aria-label={`${label}${title}百分比`}
              min={key === 'w' || key === 'h' ? 1 : 0}
              max={100}
              value={Math.round(value[key] * 100)}
              onChange={(event) => {
                const number = Number(event.target.value)
                if (!Number.isFinite(number)) return
                const next = {
                  ...value,
                  [key]: Math.max(key === 'w' || key === 'h' ? 0.01 : 0,
                    Math.min(key === 'w' || key === 'h' ? 1 : 0.99, number / 100)),
                }
                next.w = Math.min(next.w, 1 - next.x)
                next.h = Math.min(next.h, 1 - next.y)
                onChange(next)
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  )
}

interface StreamStageProps {
  role: SourceRole
  step: EditStep
  region: RoiRect
  masks: RoiRect[]
  selectedMask: number | null
  onSelectMask: (index: number | null) => void
  onRegionDraft: (roi: RoiRect) => void
  onRegionCommit: (roi: RoiRect) => void
  onResetRegion: () => void
  onMaskDraft: (index: number, roi: RoiRect) => void
  onMaskCommit: (index: number, roi: RoiRect) => void
  onAddMaskDraft: (roi: RoiRect | null, commit?: boolean) => void
  onRemoveMask: (index: number) => void
  creatingMask: RoiRect | null
}

function StreamStage({
  role,
  step,
  region,
  masks,
  selectedMask,
  onSelectMask,
  onRegionDraft,
  onRegionCommit,
  onResetRegion,
  onMaskDraft,
  onMaskCommit,
  onAddMaskDraft,
  onRemoveMask,
  creatingMask,
}: StreamStageProps): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const mediaState = snapshot.media[role]
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 })
  const regionRef = useRef(region)
  const stepRef = useRef(step)
  regionRef.current = region
  stepRef.current = step

  const drawState = useRef<{
    pointerId: number
    startClient: { x: number; y: number }
    bounds: DOMRect
    box: Rect
    started: boolean
    latest: RoiRect | null
  } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (): void => setHostSize({ width: host.clientWidth, height: host.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const video = session.engine.element(role)
    if (!video || !canvas) return
    let lastPaint = Number.NEGATIVE_INFINITY
    let lastKey = ''
    const renderFrame = (force = false): void => {
      const { videoWidth: vw, videoHeight: vh } = video
      if (!vw || !vh || video.readyState < 2) return
      const currentRegion = regionRef.current
      const currentStep = stepRef.current
      const key = `${vw}x${vh}:${currentStep}:${currentRegion.x},${currentRegion.y},${currentRegion.w},${currentRegion.h}`
      const changed = key !== lastKey
      if (!force && !changed && !video.paused && !video.seeking && performance.now() - lastPaint < 80) return
      try {
        const context = canvas.getContext('2d')
        if (!context) return
        if (currentStep === 'crop') {
          const w = Math.min(640, vw)
          const h = Math.max(1, Math.round(w * vh / vw))
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
          context.drawImage(video, 0, 0, w, h)
        } else {
          const crop = roiToPixels(currentRegion, vw, vh)
          const w = 640
          const h = 360
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
          context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, w, h)
        }
        lastPaint = performance.now()
        lastKey = key
        setVideoSize(prev => (prev.width === vw && prev.height === vh ? prev : { width: vw, height: vh }))
      } catch {
        // Ignore transient decode/readback errors while stream recovers.
      }
    }
    const stop = watchCameraFrames(video, () => renderFrame(false), { previewFallback: true })
    renderFrame(true)
    const clear = (): void => setVideoSize({ width: 0, height: 0 })
    video.addEventListener('emptied', clear)
    video.addEventListener('loadstart', clear)
    return () => {
      stop()
      video.removeEventListener('emptied', clear)
      video.removeEventListener('loadstart', clear)
    }
  }, [session, role, canvas, mediaState.status, mediaState.descriptor?.url])

  // Repaint immediately when switching step or adjusting the crop region on a paused frame.
  useEffect(() => {
    const video = session.engine.element(role)
    if (!video || !canvas || !video.videoWidth || !video.videoHeight || video.readyState < 2) return
    try {
      const context = canvas.getContext('2d')
      if (!context) return
      if (step === 'crop') {
        const w = Math.min(640, video.videoWidth)
        const h = Math.max(1, Math.round(w * video.videoHeight / video.videoWidth))
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
        context.drawImage(video, 0, 0, w, h)
      } else {
        const crop = roiToPixels(region, video.videoWidth, video.videoHeight)
        if (canvas.width !== 640 || canvas.height !== 360) { canvas.width = 640; canvas.height = 360 }
        context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, 640, 360)
      }
    } catch {
      // Ignore transient errors.
    }
  }, [session, role, canvas, step, region])

  const hasFrame = mediaState.status === 'ready' && videoSize.width > 0 && videoSize.height > 0
  const effectiveVideo = step === 'crop' && hasFrame ? videoSize : FALLBACK_VIDEO
  const pictureBox: Rect = step === 'mask'
    ? { x: 0, y: 0, width: hostSize.width, height: hostSize.height }
    : contentRect(effectiveVideo.width, effectiveVideo.height, hostSize.width, hostSize.height)

  const canDrawNew = step === 'crop' || masks.length < MAX_MASKS
  const roleLabel = role === 'official' ? '画面' : '解说'

  const beginDraw = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as Element
    if (event.button !== 0) return
    if (step === 'crop') {
      if (target.closest('.roi-handle')) return
      if (!isFullRegion(region) && target.closest('.roi-window')) return
    } else if (target.closest('.roi-window')) {
      return
    }
    if (step === 'mask') onSelectMask(null)
    if (!canDrawNew || pictureBox.width <= 0 || pictureBox.height <= 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drawState.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      bounds,
      box: pictureBox,
      started: false,
      latest: null,
    }
  }

  const moveDraw = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = drawState.current
    if (!state || state.pointerId !== event.pointerId) return
    const dist = Math.hypot(event.clientX - state.startClient.x, event.clientY - state.startClient.y)
    if (!state.started && dist < DRAG_THRESHOLD_PX) return
    state.started = true
    const start = pointToFraction({ x: state.startClient.x - state.bounds.left, y: state.startClient.y - state.bounds.top }, state.box)
    const end = pointToFraction({ x: event.clientX - state.bounds.left, y: event.clientY - state.bounds.top }, state.box)
    const next = clampBox({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x),
      h: Math.abs(end.y - start.y),
    })
    state.latest = next
    if (step === 'crop') onRegionDraft(next)
    else onAddMaskDraft(next, false)
  }

  const finishDraw = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false): void => {
    const state = drawState.current
    if (!state || state.pointerId !== event.pointerId) return
    drawState.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!state.started || !state.latest) return
    if (cancelled) {
      if (step === 'mask') onAddMaskDraft(null, false)
      return
    }
    if (step === 'crop') onRegionCommit(state.latest)
    else onAddMaskDraft(state.latest, true)
  }

  return (
    <div className="fh-card">
      <div className="fh-card-head">
        <span className="fh-card-title">
          <strong>{step === 'crop' ? roleLabel : `${roleLabel}（裁剪后）`}</strong>
          <span className="muted num">{formatRegionSummary(region)}</span>
        </span>
        {step === 'crop' && !isFullRegion(region) && (
          <button type="button" className="btn-quiet small" onClick={onResetRegion} aria-label={`${roleLabel}铺满画面`}>
            铺满画面
          </button>
        )}
      </div>

      <div
        ref={hostRef}
        className={`fh-stage${!canDrawNew ? ' is-limit' : ''}`}
        aria-label={`${roleLabel}${step === 'crop' ? '裁剪画布' : '遮罩画布'}`}
        onPointerDown={beginDraw}
        onPointerMove={moveDraw}
        onPointerUp={(event) => finishDraw(event, false)}
        onPointerCancel={(event) => finishDraw(event, true)}
      >
        <canvas
          ref={setCanvas}
          className={`fh-canvas${step === 'mask' ? ' fh-canvas--cropped' : ''}`}
          style={{ visibility: hasFrame ? undefined : 'hidden' }}
        />
        {!hasFrame && (
          <div className="fh-empty">
            {mediaState.status === 'empty' ? `未载入${roleLabel}（可直接按 16:9 预框选）` : `正在等待${roleLabel}画面…`}
          </div>
        )}

        {step === 'crop' && pictureBox.width > 0 && (
          <>
            {masks.map((mask, index) => (
              <div
                key={index}
                className="fh-mask-ghost"
                style={{
                  left: `${pictureBox.x + (region.x + mask.x * region.w) * pictureBox.width}px`,
                  top: `${pictureBox.y + (region.y + mask.y * region.h) * pictureBox.height}px`,
                  width: `${Math.max(2, mask.w * region.w * pictureBox.width)}px`,
                  height: `${Math.max(2, mask.h * region.h * pictureBox.height)}px`,
                }}
              />
            ))}
            <RoiWindow
              roi={region}
              onChange={onRegionDraft}
              onCommit={onRegionCommit}
              videoWidth={effectiveVideo.width}
              videoHeight={effectiveVideo.height}
              contentBox={pictureBox}
              bodyDraggable={!isFullRegion(region)}
              label={`${roleLabel}区域`}
              ariaLabel={`${roleLabel}有效区域`}
              unit="percent"
            />
          </>
        )}

        {step === 'mask' && pictureBox.width > 0 && (
          <>
            {masks.map((mask, index) => (
              <RoiWindow
                key={index}
                roi={mask}
                onChange={(next) => onMaskDraft(index, next)}
                onCommit={(next) => onMaskCommit(index, next)}
                videoWidth={1280}
                videoHeight={720}
                contentBox={pictureBox}
                variant="mask"
                unit="percent"
                selected={selectedMask === index}
                onSelect={() => onSelectMask(index)}
                onDelete={() => onRemoveMask(index)}
                label={`忽略 ${index + 1}`}
                ariaLabel={`${roleLabel}画布忽略区域 ${index + 1}`}
              />
            ))}
            {creatingMask && (
              <RoiWindow
                roi={creatingMask}
                onChange={() => {}}
                videoWidth={1280}
                videoHeight={720}
                contentBox={pictureBox}
                variant="mask"
                unit="percent"
                readOnly
                label={`忽略 ${masks.length + 1}`}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function FrameHashSettings(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const [step, setStep] = useState<EditStep>('crop')
  const [draftRegions, setDraftRegions] = useState<Record<SourceRole, RoiRect>>(settings.frameHashRegions)
  const [draftMasks, setDraftMasks] = useState<RoiRect[]>(settings.frameHashMasks)
  const [creatingMask, setCreatingMask] = useState<RoiRect | null>(null)
  const [selectedMask, setSelectedMask] = useState<number | null>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (!draggingRef.current) setDraftRegions(settings.frameHashRegions)
  }, [settings.frameHashRegions])

  useEffect(() => {
    if (!draggingRef.current) {
      setDraftMasks(settings.frameHashMasks)
      setSelectedMask(current => (current !== null && current < settings.frameHashMasks.length ? current : null))
    }
  }, [settings.frameHashMasks])

  const commitRegions = (next: Record<SourceRole, RoiRect>): void => {
    draggingRef.current = false
    setDraftRegions(next)
    session.updateSettings({ frameHashRegions: next })
  }

  const commitMasks = (next: RoiRect[]): void => {
    draggingRef.current = false
    setDraftMasks(next)
    session.updateSettings({ frameHashMasks: next })
  }

  const addDefaultMask = (): void => {
    if (draftMasks.length >= MAX_MASKS) return
    const offset = (draftMasks.length % 4) * 0.04
    const next = [...draftMasks, { x: 0, y: Math.min(0.85, offset), w: 1, h: 0.12 }]
    setSelectedMask(next.length - 1)
    setStep('mask')
    commitMasks(next)
  }

  const removeMask = (index: number): void => {
    const next = draftMasks.filter((_, i) => i !== index)
    setSelectedMask(current => (current === null ? null : current === index ? (next.length ? Math.min(index, next.length - 1) : null) : current > index ? current - 1 : current))
    commitMasks(next)
  }

  const resetAll = (): void => {
    draggingRef.current = false
    const regions = { official: { ...FULL }, commentary: { ...FULL } }
    setDraftRegions(regions)
    setDraftMasks([])
    setCreatingMask(null)
    setSelectedMask(null)
    session.updateSettings({ frameHashRegions: regions, frameHashMasks: [] })
  }

  const allMasksForPreview = creatingMask ? [...draftMasks, creatingMask] : draftMasks
  const visibleFraction = visibleFrameFraction(allMasksForPreview)
  const insufficientArea = visibleFraction < 0.25

  return (
    <section className="group fh-settings" aria-label="画面匹配设置">
      <div className="fh-toolbar">
        <h3>画面匹配</h3>
        <Segmented
          label="编辑模式"
          value={step}
          onChange={setStep}
          options={[
            { value: 'crop', label: '裁剪有效画面' },
            { value: 'mask', label: `标注忽略区域${draftMasks.length > 0 ? ` (${draftMasks.length})` : ''}` },
          ]}
        />
      </div>

      <p className="fh-hint">
        {step === 'crop'
          ? '拖动边框或在画面空白处拉框，让左右两路保留同一比赛视角（例如只框住二路主播画面里的游戏小窗）。'
          : '左右显示裁剪后的比赛画面。在任一侧直接拉框遮住主播摄像头、台标或贴片，两侧实时同步忽略。'}
      </p>

      <div className="fh-grid">
        {SOURCE_ROLES.map((role) => (
          <StreamStage
            key={role}
            role={role}
            step={step}
            region={draftRegions[role]}
            masks={draftMasks}
            selectedMask={selectedMask}
            onSelectMask={setSelectedMask}
            onRegionDraft={(roi) => {
              draggingRef.current = true
              setDraftRegions(prev => ({ ...prev, [role]: roi }))
            }}
            onRegionCommit={(roi) => commitRegions({ ...draftRegions, [role]: roi })}
            onResetRegion={() => commitRegions({ ...draftRegions, [role]: { ...FULL } })}
            onMaskDraft={(index, roi) => {
              draggingRef.current = true
              setDraftMasks(prev => prev.map((item, i) => (i === index ? roi : item)))
            }}
            onMaskCommit={(index, roi) => commitMasks(draftMasks.map((item, i) => (i === index ? roi : item)))}
            onAddMaskDraft={(roi, commit = false) => {
              if (!roi) {
                draggingRef.current = false
                setCreatingMask(null)
                return
              }
              if (!commit) {
                draggingRef.current = true
                setCreatingMask(roi)
                return
              }
              setCreatingMask(null)
              if (draftMasks.length >= MAX_MASKS) return
              const next = [...draftMasks, roi]
              setSelectedMask(next.length - 1)
              commitMasks(next)
            }}
            onRemoveMask={removeMask}
            creatingMask={creatingMask}
          />
        ))}
      </div>

      {insufficientArea && (
        <p className="note-warn" role="alert">
          忽略区域过大（当前仅剩 {Math.round(visibleFraction * 100)}% 有效画面），请至少保留 25% 画面
        </p>
      )}

      {draftMasks.length > 0 && (
        <div className="fh-masks-bar">
          <div className="fh-mask-chips" role="list" aria-label="忽略区域列表">
            {draftMasks.map((_, index) => (
              <span
                key={index}
                role="listitem"
                className={`fh-mask-chip${selectedMask === index ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="fh-mask-chip-select"
                  onClick={() => { setStep('mask'); setSelectedMask(index) }}
                >
                  忽略区域 {index + 1}
                </button>
                <button
                  type="button"
                  className="fh-mask-chip-remove"
                  aria-label={`移除忽略区域 ${index + 1}`}
                  title={`移除忽略区域 ${index + 1}`}
                  onClick={() => removeMask(index)}
                >
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
          {!insufficientArea && (
            <span className="muted num">保留 {Math.round(visibleFraction * 100)}% 有效画面</span>
          )}
        </div>
      )}

      <div className="fh-actions">
        <button
          type="button"
          className="btn-quiet"
          disabled={draftMasks.length >= MAX_MASKS}
          onClick={addDefaultMask}
        >
          添加忽略区域
        </button>
        <button type="button" className="btn-quiet" onClick={resetAll}>
          恢复完整画面
        </button>
      </div>

      <details className="fh-details">
        <summary className="fh-summary">精确百分比微调</summary>
        <div className="fh-details-body">
          {SOURCE_ROLES.map((role) => (
            <RegionNumbers
              key={role}
              label={role === 'official' ? '画面区域' : '解说区域'}
              value={draftRegions[role]}
              onChange={(value) => commitRegions({ ...draftRegions, [role]: value })}
            />
          ))}
          {draftMasks.map((value, index) => (
            <div key={index} className="fh-mask-fieldset">
              <RegionNumbers
                label={`忽略区域 ${index + 1}`}
                value={value}
                onChange={(next) => commitMasks(draftMasks.map((r, i) => (i === index ? next : r)))}
              />
              <div>
                <button type="button" className="btn-quiet small" onClick={() => removeMask(index)}>
                  移除忽略区域 {index + 1}
                </button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}
