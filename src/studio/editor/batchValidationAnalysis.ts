import { HUD_CUE_IDS, HUD_FIELD_IDS, type HudFieldId, type HudStylePack, type HudVariant } from '../../core/hudStylePack'
import type { HudFieldResult, HudFrameResult, HudPresenceResult } from '../../core/hudWasm'
import { CUE_LABELS } from './cueModel'
import { FIELD_LABELS } from './editorModel'
import type { ValidationField, ValidationNote, ValidationPresence, ValidationRow, ValidationSummary } from './batchValidationTypes'

const PHASE = { active: '进行中', planted: '下包', paused: '暂停', roundOver: '回合结束', statistics: '统计页', indeterminate: '无法判断', unconfigured: '未配置' }
const CONTENT = { live: '直播', replay: '回放', indeterminate: '无法判断' }
const SCORE_IDS = ['scoreLeft', 'scoreRight'] as const
const PHASE_STATES = ['statistics', 'round-history', 'scoreboard', 'paused', 'round-over', 'planted', 'active'] as const
// Large gaps can hide an entire phase or round transition. Do not infer its continuity.
const MAX_CONTINUOUS_GAP = 5

const fieldsFor = <T>(value: (id: HudFieldId) => T): Record<HudFieldId, T> => ({
  clock: value('clock'), scoreLeft: value('scoreLeft'), scoreRight: value('scoreRight'),
})

function compactField(result: HudFieldResult, enabled: boolean | undefined): ValidationField {
  if (enabled !== true) return { status: enabled === false ? 'disabled' : 'failed', text: null, value: null,
    confidence: null, reason: enabled === false ? null : 'not-configured' }
  return { status: result.status, text: result.status === 'read' ? result.reading.text : null,
    value: result.status === 'read' ? result.reading.value : null,
    confidence: result.status === 'read' ? result.reading.confidence : null,
    reason: 'reason' in result ? result.reason : null }
}

function compactPresence(result: HudPresenceResult, enabled: boolean): ValidationPresence {
  if (!enabled) return { status: 'disabled', score: null, reason: null }
  return { status: result.status, score: result.score, reason: 'reason' in result ? result.reason : null }
}

/** A disabled term removes its entire AND group, not just its direct diagnostic. */
function stateEnabled(variant: HudVariant, id: string): boolean {
  return (variant.states[id] ?? []).some(group => group.length > 0 && group.every(condition => condition.kind === 'cue'
    ? variant.cues[condition.cue]?.enabled === true : variant.fields[condition.field]?.enabled === true))
}

function observedAxes(result: HudFrameResult, variant: HudVariant): Pick<ValidationRow, 'content' | 'phase'> {
  const content = stateEnabled(variant, 'replay') || variant.cues.replay?.enabled ? result.content : 'live'
  const hasPhase = PHASE_STATES.some(id => stateEnabled(variant, id))
  const matched = (...ids: (typeof HUD_CUE_IDS)[number][]) => ids.some(id => variant.cues[id]?.enabled
    && result.cues[id]?.status === 'matched')
  let phase = result.phase
  if (phase === 'active' && !stateEnabled(variant, 'active')) phase = 'unconfigured'
  else if (phase === 'planted' && !stateEnabled(variant, 'planted') && !matched('bomb')) phase = 'unconfigured'
  else if (phase === 'paused' && !stateEnabled(variant, 'paused') && !matched('timeout', 'timeoutRight')) phase = 'unconfigured'
  else if (phase === 'roundOver' && !stateEnabled(variant, 'round-over') && !matched('roundOver')) phase = 'unconfigured'
  else if (phase === 'statistics' && !['statistics', 'round-history', 'scoreboard'].some(id => stateEnabled(variant, id))
    && !matched('roundHistory', 'scoreboard')) phase = 'unconfigured'
  else if (phase === 'indeterminate' && !hasPhase) phase = 'unconfigured'
  return { content, phase }
}

function weakFieldNotes(id: HudFieldId, result: HudFieldResult, variant: HudVariant): ValidationNote[] {
  const field = variant.fields[id]
  if (!field?.enabled || result.status !== 'read' || result.reading.source !== 'recognized') return []
  const notes: ValidationNote[] = []
  const { text, scores, confidence } = result.reading
  const separatedClock = id === 'clock' && field.grammar.kind === 'countdown' && field.grammar.format !== 'ss' && text.includes(':')
  // The engine's aggregate already excludes separators. Only map raw scores when their
  // positions are known; a shortened diagnostics array must not turn a colon into a digit.
  const evaluatedScores = separatedClock ? scores.length === text.length ? scores.filter((_, index) => text[index] !== ':') : [] : scores
  const weakest = Math.min(confidence, ...evaluatedScores)
  // Review the bottom tenth of the configured score headroom, not an absolute global cutoff.
  const scoreLimit = field.match.minScore + (1 - field.match.minScore) * 0.1
  if (field.match.minScore < 1 && weakest <= scoreLimit) notes.push({ kind: 'issue', target: id, code: 'weak-score',
    message: `${FIELD_LABELS[id]}匹配得分接近当前阈值 ${field.match.minScore.toFixed(3)}, 请抽查` })
  const weakMargins = result.debug?.matches.filter(match => match.score - match.runnerUpScore <= field.match.minMargin * 1.25) ?? []
  if (field.match.minMargin > 0 && weakMargins.length) {
    const label = separatedClock && weakMargins.every(match => match.char === ':') ? '倒计时冒号' : `${FIELD_LABELS[id]}候选字形`
    notes.push({ kind: 'issue', target: id, code: 'weak-margin',
      message: `${label}分差接近最小分差 ${field.match.minMargin.toFixed(3)}, 请抽查` })
  }
  return notes
}

function stableLive(row: ValidationRow, variant: HudVariant): boolean {
  return row.content === 'live' && (row.phase === 'active' || row.phase === 'unconfigured')
    && !(['replay', 'bomb', 'timeout', 'timeoutRight', 'roundOver', 'roundHistory', 'scoreboard'] as const)
      .some(id => variant.cues[id]?.enabled && ['matched', 'failed', 'indeterminate'].includes(row.cues[id]?.status ?? ''))
}

function uncertainField(row: ValidationRow, id: HudFieldId): boolean {
  return row.fields[id].status !== 'read' || row.notes.some(note => note.kind === 'issue' && note.target === id)
}

function compareFrames(row: ValidationRow, previous: ValidationRow, variant: HudVariant): void {
  const notes = row.notes
  if (row.content !== previous.content) notes.push({ kind: 'transition', target: 'state', code: 'content-change',
    message: `内容变化: ${CONTENT[previous.content]} -> ${CONTENT[row.content]}` })
  if (row.phase !== previous.phase) notes.push({ kind: 'transition', target: 'state', code: 'phase-change',
    message: `阶段变化: ${PHASE[previous.phase]} -> ${PHASE[row.phase]}` })

  const changedScores = SCORE_IDS.filter(id => variant.fields[id]?.enabled && row.fields[id].status === 'read' && previous.fields[id].status === 'read'
    && row.fields[id].value !== previous.fields[id].value)
  const scoresSwapped = changedScores.length === 2 && row.fields.scoreLeft.value === previous.fields.scoreRight.value
    && row.fields.scoreRight.value === previous.fields.scoreLeft.value
  if (scoresSwapped) notes.push({ kind: 'transition', target: 'state', code: 'score-swap', message: '左右比分成对交换, 请复核换边画面' })

  const gap = row.at - previous.at
  const continuous = gap <= MAX_CONTINUOUS_GAP && stableLive(row, variant) && stableLive(previous, variant) && row.phase === previous.phase
    && !row.notes.some(note => note.kind === 'issue' && note.target === 'state')
    && !previous.notes.some(note => note.kind === 'issue' && note.target === 'state')
  for (const id of changedScores) {
    const change = row.fields[id].value! - previous.fields[id].value!
    const abnormal = continuous && !scoresSwapped && !uncertainField(row, id) && !uncertainField(previous, id)
      && (change < 0 || change > 1 || changedScores.length === 2)
    notes.push({ kind: abnormal ? 'issue' : 'transition', target: id, code: abnormal ? 'score-jump' : 'score-change',
      message: `${FIELD_LABELS[id]}变化: ${previous.fields[id].text} -> ${row.fields[id].text}${abnormal ? ', 请复核是否误读或比赛切换' : ''}` })
  }

  const currentClock = row.fields.clock, oldClock = previous.fields.clock
  if (!variant.fields.clock?.enabled || uncertainField(row, 'clock') || uncertainField(previous, 'clock')) return
  if (currentClock.value! > oldClock.value!) {
    notes.push({ kind: 'transition', target: 'clock', code: 'clock-reset',
      message: `倒计时读数上升: ${oldClock.text} -> ${currentClock.text}, 可能为回合开始或画面切换, 未作正误判定` })
    return
  }
  const scoresKnown = SCORE_IDS.every(id => !variant.fields[id]?.enabled
    || (!uncertainField(row, id) && !uncertainField(previous, id)))
  // Stable scores do not prove active play: freeze time and a bomb can keep them unchanged.
  const phaseEvidence = stateEnabled(variant, 'active') && row.phase === 'active'
  if (!continuous || !phaseEvidence || !scoresKnown || changedScores.length) return
  const decrement = oldClock.value! - currentClock.value!
  // Integer HUD clocks quantize two frame times independently, allowing one second of slack.
  if (Math.abs(decrement - gap) > 1.001) notes.push({ kind: 'issue', target: 'clock', code: 'clock-jump',
    message: `倒计时变化与 ${gap.toFixed(2)}s 录像间隔不一致: ${oldClock.text} -> ${currentClock.text}, 请复核` })
}

/** Build compact evidence without teaching, repairing the pack, or retaining image/debug arrays. */
export function analyzeValidationFrame(result: HudFrameResult, pack: HudStylePack, at: number, index: number,
  previous: ValidationRow | null): ValidationRow {
  const variant = pack.variants.find(item => item.id === result.variantId)
  const row: ValidationRow = { index, at, layout: variant?.id ?? null,
    ...(variant ? observedAxes(result, variant) : { content: result.content, phase: result.phase }),
    fields: fieldsFor(id => compactField(result.fields[id], variant?.fields[id]?.enabled)), cues: {}, notes: [] }
  if (!variant) {
    const conflict = result.selectionReason === 'multiple-matches'
    row.notes.push({ kind: conflict || result.variantId !== null ? 'issue' : 'transition', target: 'layout', code: conflict ? 'multiple-layouts' : 'no-layout',
      message: conflict ? '多个布局同时匹配, 播放器无法选择' : '没有匹配布局, 本帧未作正误判定, 请检查画面与主办方模板' })
    return row
  }

  const adjacent = previous !== null && previous.index + 1 === index && previous.at < at
  const prior = adjacent && previous.layout === row.layout ? previous : null
  for (const id of HUD_FIELD_IDS) {
    const field = variant.fields[id], value = result.fields[id]
    if (!field?.enabled || value.status === 'disabled') continue
    const old = prior?.fields[id], observed = row.fields[id]
    if (value.status !== 'read' && (old?.status !== observed.status || old?.reason !== observed.reason)) row.notes.push({
      kind: 'transition', target: id, code: 'field-unavailable', message: observed.reason === 'insufficient-templates' || observed.reason === 'not-configured'
        ? `${FIELD_LABELS[id]}尚未配置完整样本, 本帧未作正误判定`
        : `${FIELD_LABELS[id]}未取得有效读数${observed.reason ? `: ${observed.reason}` : ''}, 可能未显示或暂不可读, 未作正误判定`,
    })
    else if (value.status === 'read' && old && old.status !== 'read') row.notes.push({ kind: 'transition', target: id,
      code: 'field-restored', message: `${FIELD_LABELS[id]}恢复读取: ${observed.text}` })
    row.notes.push(...weakFieldNotes(id, value, variant))
  }

  for (const id of [...HUD_CUE_IDS, 'organizer'] as const) {
    const cue = id === 'organizer' ? variant.organizer : variant.cues[id]
    const value = id === 'organizer' ? result.organizer : result.cues[id]
    if (!cue) continue
    if (!cue.enabled) { row.cues[id] = { status: 'disabled', score: null, reason: null }; continue }
    if (value) row.cues[id] = compactPresence(value, cue.enabled)
    const old = prior?.cues[id]
    if (value?.status === 'disabled') continue
    if (!value || value.status === 'failed' || value.status === 'indeterminate') {
      const reason = value && 'reason' in value ? value.reason : 'missing-result'
      if (!old || old.status !== value?.status || old.reason !== reason) row.notes.push({ kind: 'transition', target: id, code: 'cue-unreadable',
        message: `${CUE_LABELS[id]}无法可靠观测: ${reason}, 本帧未作正误判定` })
      continue
    }
    if (value.status === 'matched' && old?.status !== 'matched') row.notes.push({ kind: 'transition', target: id, code: 'cue-appeared',
      message: old?.status === 'not-matched' ? `${CUE_LABELS[id]}出现` : `当前观测到${CUE_LABELS[id]}` })
    else if (value.status === 'not-matched' && old?.status === 'matched') row.notes.push({ kind: 'transition', target: id,
      code: 'cue-disappeared', message: `${CUE_LABELS[id]}消失` })
  }

  if (row.content === 'indeterminate' && prior?.content !== row.content) row.notes.push({ kind: 'transition', target: 'state',
    code: 'content-indeterminate', message: '无法判断直播或回放, 本帧未作正误判定' })
  if (row.phase === 'indeterminate' && prior?.phase !== row.phase) row.notes.push({ kind: 'transition', target: 'state',
    code: 'phase-indeterminate', message: '当前阶段无法判断, 本帧未作正误判定' })
  if (prior) compareFrames(row, prior, variant)
  else {
    if (adjacent && previous.layout !== null) row.notes.push({ kind: 'transition', target: 'layout', code: 'layout-change',
      message: `布局变化: ${previous.layout} -> ${row.layout}` })
    if (row.content === 'replay') row.notes.push({ kind: 'transition', target: 'state', code: 'content-observed', message: '当前画面为回放, 不作连续倒计时比较' })
    if (!['active', 'unconfigured', 'indeterminate'].includes(row.phase)) row.notes.push({ kind: 'transition', target: 'state',
      code: 'phase-observed', message: `当前阶段为${PHASE[row.phase]}, 不作连续倒计时比较` })
  }
  return row
}

export function failureValidationRow(at: number, index: number, reason: string): ValidationRow {
  return { index, at, layout: null, content: 'indeterminate', phase: 'indeterminate',
    fields: fieldsFor(() => ({ status: 'failed', text: null, value: null, confidence: null, reason: 'frame-error' })), cues: {},
    notes: [{ kind: 'issue', target: 'frame', code: 'frame-error', message: `取帧或识别调用失败: ${reason}` }] }
}

/** A missing reading is coverage evidence, not a known incorrect recognition. */
export function validationUnavailable(row: ValidationRow): boolean {
  return row.layout === null || row.content === 'indeterminate' || row.phase === 'indeterminate'
    || Object.values(row.fields).some(field => (field.status === 'failed' || field.status === 'indeterminate') && field.reason !== 'not-configured')
    || Object.values(row.cues).some(cue => (cue.status === 'failed' || cue.status === 'indeterminate') && cue.reason !== 'not-configured')
}

export function summarizeValidation(rows: readonly ValidationRow[]): ValidationSummary {
  const summary: ValidationSummary = { sampled: rows.length, issueFrames: 0, unavailableFrames: 0, transitionFrames: 0,
    fields: fieldsFor(() => ({ read: 0, attempted: 0, absent: 0, disabled: 0 })) }
  for (const row of rows) {
    if (row.notes.some(note => note.kind === 'issue')) summary.issueFrames++
    if (validationUnavailable(row)) summary.unavailableFrames++
    if (row.notes.some(note => note.kind === 'transition')) summary.transitionFrames++
    if (row.layout === null) continue
    for (const id of HUD_FIELD_IDS) {
      const field = row.fields[id], count = summary.fields[id]
      if (field.status === 'disabled') count.disabled++
      else if (field.status === 'absent') count.absent++
      else if (field.reason !== 'not-configured' && field.reason !== 'insufficient-templates') {
        count.attempted++
        if (field.status === 'read') count.read++
      }
    }
  }
  return summary
}
