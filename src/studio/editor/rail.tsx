/**
 * The editor's right rail, top to bottom in the order the work happens: frame the clock,
 * clean the digits, teach the characters, review what is stored, and the few numbers that
 * are set once per broadcast.
 */

import { useEffect, useRef, useState } from 'react'
import {
  CLOCK_CHARS,
  TEMPLATE_PIXELS,
  type ClockChar,
  type RoiRect,
} from '../../core/profileSchema'
import type { HudFieldId } from '../../core/hudStylePack'
import { FIELD_LABELS, type EditorClockModel } from './editorModel'
import type { HudFieldResult } from '../../core/hudWasm'
import { unpackBitmap } from '../../core/bitmapCodec'
import { adjustGlyphBox, excludeGlyphBox, mergeGlyphBoxes, splitGlyphBox, type GlyphBox } from '../../core/segmentation'
import { Range, Segmented } from '../kit'
import { drawMask, TEMPLATE_SIZE, type FrameAnalysis } from './framePipeline'
import { PreprocessControls, type PreprocessControlsProps } from './PreprocessControls'

type Patch = (update: Partial<EditorClockModel>) => void

function RailDisclosure({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }): React.ReactNode {
  const [expanded, setExpanded] = useState(true)
  return (
    <details className="rail-group rail-collapsible" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><h2>{title}</h2>{meta}</summary>
      <div className="rail-content">{children}</div>
    </details>
  )
}

export function RegionSection({ fieldId = 'clock', label, roi, onRoi, videoSize, analysis, boxes, selected, onSelect, grayRef, binaryRef }: {
  fieldId?: HudFieldId
  label?: string
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
        <p className="muted">在画面上框住{label ?? FIELD_LABELS[fieldId]}, 载入截图或取一帧后显示裁切结果</p>
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
            <span className="roi-nudge">
              <button type="button" disabled={!field.span} aria-label={`${field.label}减 1 像素`}
                onClick={() => onRoi(nudgeRoi(roi, field.key, -1, videoSize))}>−</button>
              <em className="num">{field.span ? `${Math.round(roi[field.key] * field.span)}px` : ''}</em>
              <button type="button" disabled={!field.span} aria-label={`${field.label}加 1 像素`}
                onClick={() => onRoi(nudgeRoi(roi, field.key, 1, videoSize))}>+</button>
            </span>
          </label>
        ))}
      </div>
    </section>
  )
}

/**
 * One native pixel on one value of the region. The pack stores whole pixels, rounded from these
 * fractions, so the step lands on the next pixel. Each button changes only its own value: at the
 * picture's edge it stops rather than moving the box.
 */
export function nudgeRoi(roi: RoiRect, key: keyof RoiRect, delta: -1 | 1, size: { width: number; height: number }): RoiRect {
  const span = key === 'x' || key === 'w' ? size.width : size.height
  if (!span) return roi
  const px = { x: Math.round(roi.x * size.width), y: Math.round(roi.y * size.height),
    w: Math.round(roi.w * size.width), h: Math.round(roi.h * size.height) }
  const next = { ...px }
  if (key === 'x') next.x = Math.max(0, Math.min(size.width - px.w, px.x + delta))
  else if (key === 'y') next.y = Math.max(0, Math.min(size.height - px.h, px.y + delta))
  else if (key === 'w') next.w = Math.max(1, Math.min(size.width - px.x, px.w + delta))
  else next.h = Math.max(1, Math.min(size.height - px.y, px.h + delta))
  return { x: next.x / size.width, y: next.y / size.height, w: next.w / size.width, h: next.h / size.height }
}

export function BinarizeSection(props: PreprocessControlsProps): React.ReactNode {
  return (
    <RailDisclosure title="二值化">
      <PreprocessControls {...props} />
    </RailDisclosure>
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
export function GlyphSection({ fieldId = 'clock', profile, readiness, boxes, selected, bounds, onBoxes, onAssign,
  onVerify, recognized, reading, onUndo, busy }: {
  fieldId?: HudFieldId
  profile: EditorClockModel
  readiness: { ready: boolean; missing: ClockChar[]; sampleCount: number }
  boxes: GlyphBox[]
  selected: number
  bounds: { width: number; height: number } | null
  onBoxes: (boxes: GlyphBox[]) => void
  onAssign: (char: ClockChar) => void
  onVerify: (() => void) | null
  recognized: HudFieldResult | null
  reading: string
  onUndo: (() => void) | null
  busy: boolean
}): React.ReactNode {
  const active = selected >= 0 ? boxes[selected] : undefined
  return (
    <RailDisclosure title="字符" meta={
      <span className="rail-meta">
        {readiness.sampleCount} 个样本{readiness.ready ? '' : ` · 缺 ${readiness.missing.join(' ')}`}
      </span>
    }>
      {!bounds ? (
        <p className="muted">取一帧后，点选裁切图中的字符框，再按对应字符存为样本</p>
      ) : boxes.length === 0 ? (
        <p className="note-warn">未切出字符，请调整阈值或识别区域</p>
      ) : active ? (
        <>
          <div className="glyph-tools">
            <span className="rail-meta num">第 {selected + 1} 个 · {active.width}×{active.height}</span>
            <span className="row-end">
              <button type="button" className="btn-quiet small" disabled={busy || selected + 1 >= boxes.length}
                onClick={() => onBoxes(mergeGlyphBoxes(boxes, selected, selected + 1))}>与右侧合并</button>
              <button type="button" className="btn-quiet small" disabled={busy || active.width < 4}
                onClick={() => onBoxes(splitGlyphBox(boxes, selected, active.x + Math.floor(active.width / 2)))}>居中拆分</button>
              <button type="button" className="btn-quiet small" disabled={busy} onClick={() => onBoxes(excludeGlyphBox(boxes, selected))}>排除</button>
            </span>
          </div>
          <div className="edge-grid">
            {(['left', 'right', 'top', 'bottom'] as const).map((edge) => (
              <span key={edge} className="edge-row">
                <span>{EDGE_TEXT[edge]}</span>
                <button type="button" disabled={busy} onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, -1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}减 1 像素`}>−</button>
                <button type="button" disabled={busy} onClick={() => onBoxes(adjustGlyphBox(boxes, selected, edge, 1, bounds))}
                  aria-label={`${EDGE_TEXT[edge]}加 1 像素`}>+</button>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">点选裁切图中的字符框</p>
      )}
      <div className="reading-row">
        <span className="field-label">当前读数</span>
        <output className="reading-output num" aria-label="当前读数">{reading || '待标注'}</output>
      </div>
      <div className="reading-actions">
        <p className="muted">点击字符按钮逐个标注, 立即存入样本.{fieldId === 'clock' ? ' 完整倒计时可用于 +/-1s/10s 自动写入.' : ''}</p>
        <button type="button" className="btn-quiet small" disabled={busy || !onUndo} onClick={() => onUndo?.()}
          title="撤回上次字符标注或自动写入 (Ctrl+Z)">撤回</button>
      </div>
      {fieldId !== 'clock' && <p className="muted">左右比分共用数字样本, 两侧识别区域和二值化参数分别设置.</p>}
      <div className="char-pad" role="group" aria-label="存为字符样本">
        {CLOCK_CHARS.filter(char => fieldId === 'clock' || char !== ':').map((char) => (
          <button type="button" key={char} className={`char-key num${(profile.templates[char]?.length ?? 0) > 0 ? ' is-taught' : ''}`}
            disabled={busy || !active} onClick={() => onAssign(char)} aria-label={char}>
            {char}
          </button>
        ))}
      </div>
      <div className="verify-row">
        <button type="button" className="btn-quiet small" disabled={busy || !onVerify} onClick={() => onVerify?.()}>验证当前帧</button>
        {recognized && (
          <span className={`verify-result num ${recognized.status === 'read' ? 'is-ok' : recognized.status === 'disabled' ? '' : 'is-bad'}`} role="status">
            {recognized.status === 'read'
              ? `识别为 ${recognized.reading.text} · 置信度 ${recognized.reading.confidence.toFixed(3)}`
              : recognized.status === 'disabled' ? '字段已关闭'
                : recognized.status === 'absent' ? `画面里没有${FIELD_LABELS[fieldId]}` : `${recognized.status === 'indeterminate' ? '无法判断' : '识别失败'}: ${recognized.reason}`}
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
    </RailDisclosure>
  )
}

const EDGE_TEXT = { left: '左边', right: '右边', top: '上边', bottom: '下边' } as const

/** Stored samples, per character, as thumbnails so a bad one can be spotted and dropped. */
export function SampleSection({ fieldId = 'clock', profile, onRemove }: {
  fieldId?: HudFieldId
  profile: EditorClockModel
  onRemove: (char: ClockChar, id: string) => void
}): React.ReactNode {
  return (
    <section className="rail-group">
      <div className="rail-head">
        <h2>{fieldId === 'clock' ? '已存样本' : '左右比分共用样本'}</h2>
        <span className="rail-meta">点缩略图删除</span>
      </div>
      <div className="template-grid">
        {CLOCK_CHARS.filter(char => fieldId === 'clock' || char !== ':').map((char) => {
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

const CLOCK_FORMATS: { value: EditorClockModel['clockFormat']; label: string }[] = [
  { value: 'm:ss', label: '1:45' },
  { value: 'mm:ss', label: '01:45' },
  { value: 'ss', label: '45' },
]

/** Set once per broadcast and rarely touched again, so it starts closed. */
export function ParamsSection({ fieldId = 'clock', profile, onPatch }: { fieldId?: HudFieldId; profile: EditorClockModel; onPatch: Patch }): React.ReactNode {
  return (
    <details className="rail-group rail-more">
      <summary><h2>识别参数</h2></summary>
      {fieldId === 'clock' && <div className="field-stack">
        <span className="field-label">倒计时格式</span>
        <Segmented label="倒计时格式" value={profile.clockFormat} options={CLOCK_FORMATS}
          onChange={(clockFormat) => onPatch({ clockFormat })} />
      </div>}
      <Range label="匹配阈值" min={0.5} max={0.99} step={0.01} value={profile.matchThreshold}
        format={(value) => value.toFixed(2)} onChange={(matchThreshold) => onPatch({ matchThreshold })} />
      <p className="muted">调高会漏读，调低会误读</p>
      <div className="field-stack">
        {([
          ['minColumnInk', '每列最少前景像素'], ['minGlyphWidth', '最小字符宽度'], ['minGapWidth', '最小字符间隔'],
        ] as const).map(([key, label]) => (
          <label className="roi-field" key={key}><span>{label}</span>
            <input className="num" type="number" min={1} max={16384} step={1} aria-label={label} value={profile.segment[key]}
              onChange={event => {
                const value = Number(event.target.value)
                if (Number.isInteger(value) && value >= 1 && value <= 16384) onPatch({ segment: { ...profile.segment, [key]: value } })
              }} />
          </label>
        ))}
      </div>
      <Range label="最小前景比例" min={0} max={1} step={0.01} value={profile.segment.minInkRatio}
        format={value => value.toFixed(2)} onChange={minInkRatio => onPatch({ segment: { ...profile.segment, minInkRatio } })} />
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
