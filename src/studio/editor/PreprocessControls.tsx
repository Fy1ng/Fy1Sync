import { useEffect, useMemo, useRef, useState } from 'react'
import { createHudPreprocess, type HudPreprocessSettings } from '../../core/hudPreprocess'
import { roiToPixels } from '../../core/imageOps'
import type { GrabbedFrame } from '../../recognition/frameGrabber'
import { Range, Switch } from '../kit'
import type { EditorClockModel } from './editorModel'

export interface PreprocessControlsProps {
  profile: EditorClockModel
  onPatch: (update: Partial<EditorClockModel>) => void
  frame?: GrabbedFrame | null
  busy?: boolean
  onRecommend?: (kind: 'threshold' | 'polarity' | 'hsv', point?: { x: number; y: number }) => void
}

type HsvKey = keyof HudPreprocessSettings['hsv']
const DEFAULTS = createHudPreprocess()
const HSV_LIMITS: Record<HsvKey, [number, number]> = {
  hue: [0, 359], tolerance: [0, 180], saturationMin: [0, 1], saturationMax: [0, 1], valueMin: [0, 1], valueMax: [0, 1],
}

function isDefault(settings: HudPreprocessSettings): boolean {
  return (['mode', 'scale', 'threshold', 'invert'] as const).every(key => settings[key] === DEFAULTS[key])
    && settings.adaptive.windowSize === DEFAULTS.adaptive.windowSize && settings.adaptive.offset === DEFAULTS.adaptive.offset
    && (Object.keys(DEFAULTS.hsv) as HsvKey[]).every(key => settings.hsv[key] === DEFAULTS.hsv[key])
}

const percent = (value: number): string => `${Math.round(value * 100)}%`

export function PreprocessControls({ profile, onPatch, frame = null, busy = false, onRecommend }: PreprocessControlsProps): React.ReactNode {
  const { preprocess, roi } = profile
  const [picking, setPicking] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const crop = useMemo(() => frame && frame.width > 0 && frame.height > 0 && frame.pixels.length >= frame.width * frame.height * 4
    ? roiToPixels(roi, frame.width, frame.height) : null, [frame, roi.x, roi.y, roi.w, roi.h])
  const canRecommend = crop !== null && !busy && onRecommend !== undefined
  const set = (update: Partial<HudPreprocessSettings>): void => {
    if (!busy) onPatch({ preprocess: { ...preprocess, ...update } })
  }
  const setHsv = (key: HsvKey, value: number): void => {
    if (!Number.isFinite(value)) return
    const [min, max] = HSV_LIMITS[key]
    let next = Math.max(min, Math.min(max, value))
    if (key === 'saturationMin') next = Math.min(next, preprocess.hsv.saturationMax)
    else if (key === 'saturationMax') next = Math.max(next, preprocess.hsv.saturationMin)
    else if (key === 'valueMin') next = Math.min(next, preprocess.hsv.valueMax)
    else if (key === 'valueMax') next = Math.max(next, preprocess.hsv.valueMin)
    set({ hsv: { ...preprocess.hsv, [key]: next } })
  }

  useEffect(() => { setPicking(false) }, [frame, crop, preprocess.mode, busy])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frame || !crop || preprocess.mode !== 'hsv') return
    const context = canvas.getContext('2d')
    if (!context) return
    const image = context.createImageData(crop.width, crop.height)
    // Copy only the native RGBA crop; preprocessing must not change the color picker.
    for (let row = 0; row < crop.height; row++) {
      const start = ((crop.y + row) * frame.width + crop.x) * 4
      image.data.set(frame.pixels.subarray(start, start + crop.width * 4), row * crop.width * 4)
    }
    context.putImageData(image, 0, 0)
  }, [frame, crop, preprocess.mode])

  return <>
    <div className="rail-reset-row">
      <button type="button" className="link-btn rail-link" disabled={busy || isDefault(preprocess)}
        onClick={() => set(createHudPreprocess())}>恢复默认</button>
    </div>
    <label className="field-stack">
      <span className="field-label">二值化模式</span>
      <select className="text-input" aria-label="二值化模式" value={preprocess.mode} disabled={busy}
        onChange={event => {
          const mode = event.target.value
          if (mode === 'gray' || mode === 'adaptive' || mode === 'hsv') set({ mode })
        }}>
        <option value="gray">灰度阈值</option>
        <option value="adaptive">自适应阈值</option>
        <option value="hsv">HSV 颜色分割</option>
      </select>
    </label>
    {preprocess.mode !== 'hsv' && <Range label="对比度" min={0.5} max={3} step={0.1} value={preprocess.scale}
      format={value => `${value.toFixed(1)}x`} disabled={busy} onChange={scale => set({ scale })} />}
    {preprocess.mode === 'gray' && <>
      <Range label="阈值" min={0} max={255} step={1} value={preprocess.threshold} disabled={busy}
        onChange={threshold => set({ threshold })} />
      <button type="button" className="btn-quiet small" disabled={!canRecommend}
        onClick={() => { if (canRecommend) onRecommend?.('threshold') }}>自动推荐阈值</button>
    </>}
    {preprocess.mode === 'adaptive' && <>
      <label className="roi-field"><span>局部窗口大小</span>
        <input className="num" type="number" aria-label="局部窗口大小" min={3} max={255} step={2}
          value={preprocess.adaptive.windowSize} disabled={busy} onChange={event => {
            const windowSize = Number(event.target.value)
            if (Number.isInteger(windowSize) && windowSize >= 3 && windowSize <= 255 && windowSize % 2 === 1)
              set({ adaptive: { ...preprocess.adaptive, windowSize } })
          }} />
      </label>
      <Range label="局部偏移量" min={0} max={128} step={1} value={preprocess.adaptive.offset} disabled={busy}
        onChange={offset => set({ adaptive: { ...preprocess.adaptive, offset } })} />
      <p className="muted">窗口使用 3-255 的奇数. 白字须高于局部均值加偏移量, 反相时暗字须低于局部均值减偏移量.</p>
    </>}
    {preprocess.mode === 'hsv' && <>
      <Range label="色相" min={0} max={359} step={1} value={preprocess.hsv.hue} disabled={busy} onChange={value => setHsv('hue', value)} />
      <Range label="色相容差" min={0} max={180} step={1} value={preprocess.hsv.tolerance} disabled={busy} onChange={value => setHsv('tolerance', value)} />
      <Range label="最低饱和度" min={0} max={1} step={0.01} value={preprocess.hsv.saturationMin} disabled={busy}
        format={percent} onChange={value => setHsv('saturationMin', value)} />
      <Range label="最高饱和度" min={0} max={1} step={0.01} value={preprocess.hsv.saturationMax} disabled={busy}
        format={percent} onChange={value => setHsv('saturationMax', value)} />
      <Range label="最低明度" min={0} max={1} step={0.01} value={preprocess.hsv.valueMin} disabled={busy}
        format={percent} onChange={value => setHsv('valueMin', value)} />
      <Range label="最高明度" min={0} max={1} step={0.01} value={preprocess.hsv.valueMax} disabled={busy}
        format={percent} onChange={value => setHsv('valueMax', value)} />
      <button type="button" className={`${picking ? 'btn-solid' : 'btn-quiet'} small`} disabled={!canRecommend}
        aria-pressed={picking} onClick={() => { if (canRecommend) setPicking(current => !current) }}>从原图取色</button>
      {crop ? <>
        <canvas ref={canvasRef} className={`preprocess-color-preview${picking ? ' is-picking' : ''}`}
          width={crop.width} height={crop.height} role="img" aria-label="原图取色"
          onClick={event => {
            if (!picking || !canRecommend) return
            const rect = event.currentTarget.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) return
            const x = crop.x + Math.max(0, Math.min(crop.width - 1, Math.floor((event.clientX - rect.left) / rect.width * crop.width)))
            const y = crop.y + Math.max(0, Math.min(crop.height - 1, Math.floor((event.clientY - rect.top) / rect.height * crop.height)))
            setPicking(false)
            onRecommend?.('hsv', { x, y })
          }} />
        <p className="muted">{picking ? '点击图标前景取色' : '显示原始彩色区域, 不受二值化参数影响.'}</p>
      </> : <p className="muted">先取一帧, 再从原图选择前景颜色.</p>}
    </>}
    <Switch label="反相" detail="浅底深字时打开" checked={preprocess.invert} disabled={busy} onChange={invert => set({ invert })} />
    <button type="button" className="btn-quiet small" disabled={!canRecommend}
      onClick={() => { if (canRecommend) onRecommend?.('polarity') }}>自动判断反相</button>
    <p className="muted">自动推荐只对当前帧计算, 结果固定, 不会逐帧跳变.</p>
  </>
}
