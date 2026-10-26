/**
 * The editor's right rail, top to bottom in the order the work happens: frame the clock,
 * clean the digits, teach the characters, review what is stored, and the few numbers that
 * are set once per broadcast.
 */

import { useEffect, useRef } from 'react'
import {
  CLOCK_CHARS,
  DEFAULT_PREPROCESS,
  TEMPLATE_PIXELS,
  type ClockChar,
  type RecognitionProfile,
  type RoiRect,
} from '../../core/profileSchema'
import type { CountdownFormat } from '../../core/clockJump'
import type { RecognizeResult } from '../../core/templateMatch'
import { unpackBitmap } from '../../core/bitmapCodec'
import { adjustGlyphBox, excludeGlyphBox, mergeGlyphBoxes, splitGlyphBox, type GlyphBox } from '../../core/segmentation'
import { Range, Segmented, Switch } from '../kit'
import { drawMask, TEMPLATE_SIZE, type FrameAnalysis } from './framePipeline'

type Patch = (update: Partial<RecognitionProfile>) => void

export function RegionSection({ roi, onRoi, videoSize, analysis, boxes, selected, onSelect, grayRef, binaryRef }: {
  roi: RoiRect
  onRoi: (roi: RoiRect) => void
  videoSize: { width: number; height: number }
  analysis: FrameAnalysis | null
  boxes: GlyphBox[]
  selected: number
  onSelect: (index: number) => void
  grayRef: React.RefObject<HTMLCanvasElement | null>
  binaryRef: React.RefObject<HTMLCanvasElement | null>
}): React.ReactNode {
  const fields: { key: keyof RoiRect; label: string; span: number }[] = [
    { key: 'x', label: 'X', span: videoSize.width },
    { key: 'y', label: 'Y', span: videoSize.height },
    { key: 'w', label: '宽', span: videoSize.width },
    { key: 'h', label: '高', span: videoSize.height },
  ]
  return (
    <section className="rail-group">
      <h2>识别区域</h2>
      {analysis ? (
        <div className="crop-pair">
          <canvas ref={grayRef} className="crop-canvas" aria-label="原图裁切" />
          <div className="crop-binary">
            <canvas ref={binaryRef} className="crop-canvas" aria-label="二值化结果" />
            {boxes.map((box, index) => (
              <button
                type="button"
                key={`${box.x}-${box.y}-${index}`}
                className={`glyph-box${index === selected ? ' is-selected' : ''}`}
                style={{
                  left: `${(box.x / analysis.binary.width) * 100}%`,
                  top: `${(box.y / analysis.binary.height) * 100}%`,
                  width: `${(box.width / analysis.binary.width) * 100}%`,
                  height: `${(box.height / analysis.binary.height) * 100}%`,
                }}
                onClick={() => onSelect(index)}
                aria-label={`字符 ${index + 1}，${box.width}×${box.height}`}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">在画面上框住倒计时，载入截图或取一帧后显示裁切结果</p>
      )}
      <div className="roi-fields">
        {fields.map((field) => (
          <label key={field.key} className="roi-field">
            <span>{field.label}</span>
            <input
              type="number"
              className="num"
              min={0}
              max={1}
              step={0.001}
              value={roi[field.key].toFixed(4)}
              onChange={(event) => {
                const next = Number(event.target.value)
                if (Number.isFinite(next)) onRoi({ ...roi, [field.key]: next })
              }}
            />
            {/* Fractions are what gets stored; pixels are what the user can see on screen. */}
            <em className="num">{field.span ? `${Math.round(roi[field.key] * field.span)}px` : ''}</em>
          </label>
        ))}
      </div>
    </section>
  )
}

export function BinarizeSection({ profile, onPatch }: { profile: RecognitionProfile; onPatch: Patch }): React.ReactNode {
  const set = (update: Partial<RecognitionProfile['preprocess']>): void =>
    onPatch({ preprocess: { ...profile.preprocess, ...update } })
  const changed = profile.preprocess.scale !== DEFAULT_PREPROCESS.scale
    || profile.preprocess.threshold !== DEFAULT_PREPROCESS.threshold
    || profile.preprocess.invert !== DEFAULT_PREPROCESS.invert
  return (
    <section className="rail-group">
      <div className="rail-head">
        <h2>二值化</h2>
        <button type="button" className="link-btn rail-link" disabled={!changed} onClick={() => set({ ...DEFAULT_PREPROCESS })}>恢复默认</button>
      </div>
      <Range label="对比度" min={0.5} max={3} step={0.1} value={profile.preprocess.scale}
        format={(value) => `${value.toFixed(1)}×`} onChange={(scale) => set({ scale })} />
      <Range label="阈值" min={0} max={255} step={1} value={profile.preprocess.threshold}
        onChange={(threshold) => set({ threshold })} />
      <Switch label="反相" detail="浅底深字时打开" checked={profile.preprocess.invert} onChange={(invert) => set({ invert })} />
    </section>
  )
}

/**
 * Glyph cutting and teaching.
 *
 * Automatic segmentation is a column-projection cut, which fails predictably: touching
 * digits become one box, a colon becomes two, and a scoreboard's separator line becomes a
 * box of its own. Rather than adding heuristics for each case, the user fixes the boxes
 * directly (merge, split, drop, nudge an edge) and then teaches from those.
 */
export function GlyphSection({ profile, readiness, boxes, selected, bounds, onBoxes, onAssign, onVerify, recognized }: {
  profile: RecognitionProfile
  readiness: { ready: boolean; missing: ClockChar[]; sampleCount: number }
  boxes: GlyphBox[]
  selected: number
  bounds: { width: number; height: number } | null
  onBoxes: (boxes: GlyphBox[]) => void
  onAssign: (char: ClockChar) => void
  onVerify: (() => void) | null
  recognized: RecognizeResult | null
}): React.ReactNode {
  const active = selected >= 0 ? boxes[selected] : undefined
  return (
    <section className="rail-group">
      <div className="rail-head">
        <h2>字符</h2>
        <span className="rail-meta">
          {readiness.sampleCount} 个样本{readiness.ready ? '' : ` · 缺 ${readiness.missing.join(' ')}`}
        </span>
      </div>
      {!bounds ? (
        <p className="muted">取一帧后，点选裁切图中的字符框，再按对应字符存为样本</p>
      ) : boxes.length === 0 ? (
        <p className="note-warn">未切出字符，请调整阈值或识别区域</p>
      ) : active ? (
        <>
          <div className="glyph-tools">
            <span className="rail-meta num">第 {selected + 1} 个 · {active.width}×{active.height}</span>
            <span className="row-end">
              <button type="button" className="btn-quiet small" disabled={selected + 1 >= boxes.length}
                onClick={() => onBoxes(mergeGlyphBoxes(boxes, selected, selected + 1))}>与右侧合并</button>
              <button type="button" className="btn-quiet small" disabled={active.width < 4}
                onClick={() => onBoxes(splitGlyphBox(boxes, selected, active.x + Math.floor(active.width / 2)))}>居中拆分</button>
              <button type="button" className="btn-quiet small" onClick={() => onBoxes(excludeGlyphBox(boxes, selected))}>排除</button>
            </span>
          </div>
          <div className="edge-grid">
            {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
              <span key={edge} className="edge-row">
                <span>{EDGE_TEXT[edge]}</span>
                <button type="button" onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, -1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}减 1 像素`}>−</button>
                <button type="button" onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, 1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}加 1 像素`}>+</button>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">点选裁切图中的字符框</p>
      )}
      <div className="char-pad" role="group" aria-label="存为字符样本">
        {CLOCK_CHARS.map((char) => (
          <button type="button" key={char} className={`char-key num${(profile.templates[char]?.length ?? 0) > 0 ? ' is-taught' : ''}`}
            disabled={!active} onClick={() => onAssign(char)} aria-label={char}>
            {char}
          </button>
        ))}
      </div>
      <div className="verify-row">
        <button type="button" className="btn-quiet small" disabled={!onVerify} onClick={() => onVerify?.()}>验证当前帧</button>
        {recognized && (
          <span className={`verify-result num ${recognized.outcome.status === 'success' ? 'is-ok' : 'is-bad'}`} role="status">
            {recognized.outcome.status === 'success'
              ? `识别为 ${recognized.outcome.reading.text} · 置信度 ${recognized.outcome.reading.confidence.toFixed(3)}`
              : `识别失败：${recognized.outcome.detail || recognized.outcome.reason}`}
          </span>
        )}
      </div>
      {recognized?.debug && recognized.debug.matches.length > 0 && (
        <ol className="match-list num">
          {recognized.debug.matches.map((match, index) => (
            <li key={index}>
              <b>{match.char ?? '?'}</b>
              <span>{match.score.toFixed(3)}</span>
              <span className="muted">次优 {match.runnerUpScore.toFixed(3)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const EDGE_TEXT = { left: '左边', right: '右边', top: '上边', bottom: '下边' } as const

/** Stored samples, per character, as thumbnails so a bad one can be spotted and dropped. */
export function SampleSection({ profile, onRemove }: {
  profile: RecognitionProfile
  onRemove: (char: ClockChar, id: string) => void
}): React.ReactNode {
  return (
    <section className="rail-group">
      <div className="rail-head">
        <h2>已存样本</h2>
        <span className="rail-meta">点缩略图删除</span>
      </div>
      <div className="template-grid">
        {CLOCK_CHARS.map((char) => {
          const samples = profile.templates[char] ?? []
          return (
            <div key={char} className={`template-cell${samples.length === 0 ? ' is-empty' : ''}`}>
              <span className="template-char num">{char}</span>
              <span className="template-samples">
                {samples.map((sample) => (
                  <button type="button" key={sample.id} className="template-thumb"
                    title={`${sample.origin ?? '未知来源'}，点击删除`} aria-label={`删除字符 ${char} 的样本`}
                    onClick={() => onRemove(char, sample.id)}>
                    <SampleThumb data={sample.data} />
                  </button>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

const CLOCK_FORMATS: { value: CountdownFormat; label: string }[] = [
  { value: 'm:ss', label: '1:45' },
  { value: 'mm:ss', label: '01:45' },
  { value: 'ss', label: '45' },
  { value: 'auto', label: '自动' },
]

/** Set once per broadcast and rarely touched again, so it starts closed. */
export function ParamsSection({ profile, onPatch }: { profile: RecognitionProfile; onPatch: Patch }): React.ReactNode {
  return (
    <details className="rail-group rail-more">
      <summary><h2>识别参数</h2></summary>
      <div className="field-stack">
        <span className="field-label">倒计时格式</span>
        <Segmented label="倒计时格式" value={profile.clockFormat} options={CLOCK_FORMATS}
          onChange={(clockFormat) => onPatch({ clockFormat })} />
      </div>
      <Range label="识别窗口" min={1} max={6} step={1} value={profile.detectWindowSeconds} unit=" 秒"
        onChange={(detectWindowSeconds) => onPatch({ detectWindowSeconds })} />
      <Range label="采样帧率" min={5} max={60} step={5} value={profile.sampleFps} unit=" fps"
        onChange={(sampleFps) => onPatch({ sampleFps })} />
      <Range label="匹配阈值" min={0.5} max={0.99} step={0.01} value={profile.matchThreshold}
        format={(value) => value.toFixed(2)} onChange={(matchThreshold) => onPatch({ matchThreshold })} />
      <p className="muted">调高会漏读，调低会误读</p>
      <label className="field-stack">
        <span className="field-label">备注</span>
        <textarea className="text-input" rows={2} value={profile.notes ?? ''} aria-label="备注"
          placeholder="赛事名称、倒计时位置" onChange={(event) => onPatch({ notes: event.target.value })} />
      </label>
    </details>
  )
}

function SampleThumb({ data }: { data: string }): React.ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    try {
      drawMask(canvasRef.current, {
        data: unpackBitmap(data, TEMPLATE_PIXELS),
        width: TEMPLATE_SIZE.width,
        height: TEMPLATE_SIZE.height,
      })
    } catch {
      // A corrupt sample draws nothing rather than taking the rail down.
    }
  }, [data])
  return <canvas ref={canvasRef} className="thumb-canvas" />
}
