import { useEffect, useRef } from 'react'
import { HUD_CUE_IDS, type HudCondition, type HudStylePack } from '../../core/hudStylePack'
import type { HudFrameResult, HudPresenceResult } from '../../core/hudWasm'
import { unpackBitmap } from '../../core/bitmapCodec'
import { Range } from '../kit'
import { drawMask } from './framePipeline'
import { CUE_LABELS, STATE_LABELS, editorCue, type CueTarget } from './cueModel'
import { editorVariant } from './layoutModel'

export function presenceText(result: HudPresenceResult | undefined, organizer = false): string {
  if (!result) return '尚未预览'
  if (result.status === 'disabled') return '已关闭'
  const text = result.status === 'matched' ? organizer ? '匹配' : '出现'
    : result.status === 'not-matched' ? organizer ? '不匹配' : '不出现'
      : result.status === 'failed' ? `识别失败: ${result.reason}` : `无法判断: ${result.reason}`
  return `${text}${result.score === null ? '' : ` / 得分 ${result.score.toFixed(3)}`}`
}
export function CueSection({ id, pack, variantId, result, onSave, onThreshold, onRemove }: {
  id: CueTarget; pack: HudStylePack; result: HudPresenceResult | undefined; onSave: (() => void) | null
  variantId?: string
  onThreshold: (value: number) => void; onRemove: (bitmapId: string) => void
}): React.ReactNode {
  const cue = editorCue(pack, id, variantId)
  return <section className="rail-group">
    <div className="rail-head"><h2>固定图形模板</h2><span className="rail-meta">{cue.templates.length} 个模板</span></div>
    <Range label="匹配阈值" min={0} max={1} step={0.01} value={cue.minScore} format={value => value.toFixed(2)} onChange={onThreshold} />
    <div className="verify-row">
      <button type="button" className="btn-solid small" disabled={!onSave} onClick={() => onSave?.()}>存为模板</button>
      <span className={`cue-result num ${result?.status === 'matched' ? 'is-ok' : ''}`} role="status">{presenceText(result, id === 'organizer')}</span>
    </div>
    <div className="cue-templates">{cue.templates.map(bitmapId => <button type="button" className="template-thumb" key={bitmapId}
      aria-label={`删除${CUE_LABELS[id]}的模板`} title="点击删除模板" onClick={() => onRemove(bitmapId)}>
      <CueThumb pack={pack} bitmapId={bitmapId} />
    </button>)}</div>
    <p className="muted">整块区域保存为模板. 改变区域宽高后需要重新取样.</p>
    {(id === 'timeout' || id === 'timeoutRight') && <p className="muted">左右 Timeout 分别框选和取样, 任意一侧出现即标记暂停. 只框固定文字或图形, 不含队名和变化的秒数.</p>}
  </section>
}
function CueThumb({ pack, bitmapId }: { pack: HudStylePack; bitmapId: string }): React.ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const bitmap = pack.bitmaps[bitmapId]!
  useEffect(() => drawMask(canvas.current, { ...bitmap, data: unpackBitmap(bitmap.data, bitmap.width * bitmap.height) }), [bitmap])
  return <canvas ref={canvas} className="thumb-canvas" />
}

/** Each row edits cue requirements; imported OR groups and field clauses remain intact. */
export function StateRules({ pack, variantId, onChange }: { pack: HudStylePack; variantId?: string; onChange: (states: Record<string, HudCondition[][]>) => void }): React.ReactNode {
  const variant = editorVariant(pack, variantId)
  const states = variant.states
  const ids = [...new Set([...Object.keys(STATE_LABELS), ...Object.keys(states)])]
  const change = (id: string, groupIndex: number, cue: typeof HUD_CUE_IDS[number], value: string): void => {
    if (!variant.cues[cue]?.enabled) return
    const groups = (states[id] ?? [[]]).map(group => [...group])
    const group = groups[groupIndex]!.filter(condition => condition.kind !== 'cue' || condition.cue !== cue)
    if (value !== '') group.push({ kind: 'cue', cue, present: value === 'present' })
    groups[groupIndex] = group
    const next = { ...states }
    const kept = groups.filter(item => item.length)
    if (kept.length) next[id] = kept
    else delete next[id]
    onChange(next)
  }
  return <details className="rail-group state-rules"><summary><h2>状态规则</h2></summary>
    <p className="muted">组内全部满足, 任一组满足即成立. 引用已关闭字段的组不参与判断, 其他组不受影响. 未配置 cue 需先框区域.</p>
    <p className="muted">任意一侧 Timeout 出现会直接标记暂停, 无需将左右两侧都设为必须出现.</p>
    {ids.map(id => <div className="state-rule" key={id}><b>{STATE_LABELS[id] ?? id}</b>
      {(states[id] ?? [[]]).map((group, groupIndex) => <div className="state-rule-cues" key={groupIndex}>
        {HUD_CUE_IDS.map(cue => {
          const condition = group.find(item => item.kind === 'cue' && item.cue === cue)
          const closed = variant.cues[cue]?.enabled === false
          const label = `${CUE_LABELS[cue]}${closed ? ' (已关闭)' : ''}`
          return <label key={cue}><span>{label}</span><select aria-label={`${STATE_LABELS[id] ?? id} ${groupIndex + 1} ${label}`}
            disabled={!variant.cues[cue]?.enabled} value={condition ? condition.present ? 'present' : 'absent' : ''}
            onChange={event => change(id, groupIndex, cue, event.target.value)}>
            <option value="">不限</option><option value="present">出现</option><option value="absent">不出现</option>
          </select></label>
        })}
        {group.filter(item => item.kind === 'field').map((condition, index) => <span className="muted" key={index}>
          {condition.kind === 'field' ? `${condition.field}: ${condition.present ? '读到' : '不在'}${variant.fields[condition.field]?.enabled === false ? ' (已关闭)' : ''}` : ''}
        </span>)}
        {group.some(condition => condition.kind === 'cue' ? variant.cues[condition.cue]?.enabled === false
          : variant.fields[condition.field]?.enabled === false)
          && <p className="note-warn">该组引用了已关闭字段, 暂不参与判断</p>}
      </div>)}
    </div>)}
  </details>
}
const CONTENT = { live: '直播', replay: '回放', indeterminate: '无法判断' }
const PHASE = { active: '进行中', planted: '下包', paused: '暂停', roundOver: '回合结束', statistics: '统计页', indeterminate: '无法判断', unconfigured: '未配置' }
export function FrameStatePreview({ result, playerResult }: { result: HudFrameResult | null; playerResult?: HudFrameResult | null }): React.ReactNode {
  const leftTimeout = result?.cues.timeout?.status === 'matched'
  const rightTimeout = result?.cues.timeoutRight?.status === 'matched'
  return <section className="rail-group frame-state-preview" aria-label="当前帧状态">
    <h2>当前帧状态</h2>
    <p>内容: <span data-testid="hud-content">{result ? CONTENT[result.content] : '尚未预览'}</span></p>
    <p>阶段: <span data-testid="hud-phase">{result ? PHASE[result.phase] : '尚未预览'}</span></p>
    {(leftTimeout || rightTimeout) && <p>暂停标记: <span data-testid="hud-timeout-side">{leftTimeout && rightTimeout ? '左右两侧' : leftTimeout ? '左侧队伍' : '右侧队伍'}</span></p>}
    <p>主办方: <span data-testid="hud-organizer">{presenceText(result?.organizer, true)}</span></p>
    <p>播放器布局: <span data-testid="hud-player-layout">{!playerResult ? '尚未预览' : playerResult.variantId
      ?? (playerResult.selectionReason === 'multiple-matches' ? '无法判断: 多个布局匹配' : '无法判断: 没有布局匹配')}</span></p>
  </section>
}
