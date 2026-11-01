import { useEffect, useId, useMemo, useState } from 'react'
import { HUD_CUE_IDS, HUD_FIELD_IDS } from '../../core/hudStylePack'
import { CUE_LABELS } from './cueModel'
import { FIELD_LABELS } from './editorModel'
import { summarizeValidation, validationUnavailable } from './batchValidationAnalysis'
import { MAX_VALIDATION_SAMPLES, type ValidationField, type ValidationPresence, type ValidationRange,
  type ValidationState, type ValidationTarget } from './batchValidationTypes'
import './batchValidation.css'

interface Props {
  duration: number
  mediaTime: number
  sourceName: string
  state: ValidationState
  onStart: (range: ValidationRange) => void
  onStop: () => void
  onInspect: (index: number) => void
  onJump: (at: number) => void
  onClose: () => void
}

type Filter = 'issues' | 'transitions' | 'all'
const PAGE_SIZE = 50
const CONTENT = { live: '直播', replay: '回放', indeterminate: '内容无法判断' }
const PHASE = { active: '进行中', planted: '下包', paused: '暂停', roundOver: '回合结束', statistics: '统计页',
  indeterminate: '阶段无法判断', unconfigured: '阶段未配置' }
const TARGET: Record<ValidationTarget, string> = { ...FIELD_LABELS, ...CUE_LABELS, layout: '布局', state: '状态', frame: '画面' }
const FIELD_STATE = { read: '已读取', absent: '未出现', disabled: '已关闭', failed: '未读出', indeterminate: '未判定' }
const CUE_STATE = { matched: '出现', 'not-matched': '不出现', disabled: '已关闭', failed: '未判定', indeterminate: '未判定' }
const time = (at: number): string => `${at.toFixed(2)}s`
const reading = (field: ValidationField): string => field.status === 'read' ? field.text ?? String(field.value ?? '')
  : field.reason === 'not-configured' ? '未配置' : FIELD_STATE[field.status]
const cueText = (cue: ValidationPresence): string => `${cue.reason === 'not-configured' ? '未配置' : CUE_STATE[cue.status]}${cue.score === null ? '' : ` / 得分 ${cue.score.toFixed(3)}`}`

export function BatchValidationPanel({ duration, mediaTime, sourceName, state, onStart, onStop, onInspect, onJump, onClose }: Props): React.ReactNode {
  const available = Number.isFinite(duration) && duration > 0
  const currentTime = Number.isFinite(mediaTime) ? Math.max(0, Math.min(mediaTime, available ? duration : 0)) : 0
  const [from, setFrom] = useState(String(currentTime))
  const [to, setTo] = useState(String(available ? Math.min(currentTime + 60, duration) : 0))
  const [step, setStep] = useState(1)
  const [filter, setFilter] = useState<Filter>('issues')
  const [page, setPage] = useState(0)
  const detailsId = useId()
  const running = state.phase === 'running'
  const busy = running || state.previewBusy
  const runIdentity = state.run ? JSON.stringify(state.run) : ''

  useEffect(() => {
    setFrom(String(currentTime))
    setTo(String(available ? Math.min(currentTime + 60, duration) : 0))
    setPage(0)
  }, [duration, sourceName])
  useEffect(() => { setPage(0) }, [filter, runIdentity])

  const start = Number(from), end = Number(to)
  const validNumbers = from.trim() !== '' && to.trim() !== '' && Number.isFinite(start) && Number.isFinite(end)
  const planned = validNumbers && end > start ? Math.ceil((end - start) / step - 1e-9) : 0
  const rangeError = !available ? '载入可定位的录像后才能开始验收.'
    : !validNumbers ? '请输入有效的起止秒数.'
      : start < 0 || end > duration ? `范围必须在 0 到 ${duration.toFixed(2)}s 内.`
        : end <= start ? '结束时间必须晚于开始时间.'
          : planned > MAX_VALIDATION_SAMPLES ? `本次超过 ${MAX_VALIDATION_SAMPLES} 帧, 请缩短区间或增大抽样间隔.` : null
  const summary = useMemo(() => summarizeValidation(state.rows), [state.rows])
  const filtered = useMemo(() => state.rows.filter(row => filter === 'all' || (filter === 'transitions' && validationUnavailable(row))
    || row.notes.some(note => note.kind === (filter === 'issues' ? 'issue' : 'transition'))), [state.rows, filter])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const selected = state.rows.find(row => row.index === state.selectedIndex)
  const preview = selected && state.preview?.index === selected.index ? state.preview : null
  const status = state.phase === 'running' ? '正在验收'
    : state.phase === 'complete' ? '验收完成'
      : state.phase === 'stopped' ? '已停止验收, 已保留部分结果'
        : state.phase === 'error' ? '验收中断, 已保留部分结果' : '等待开始'

  return <section className="batch-validation" aria-label="只读批量验收">
    <header className="batch-validation-head">
      <div><h2>只读批量验收</h2><p className="muted">固定样式包快照, 只识别不标注, 不会保存或修改样本.</p></div>
      <button type="button" className="btn-quiet small" onClick={onClose} disabled={busy}
        title={busy ? '停止验收或等待读取结束后返回制作' : undefined}>返回制作</button>
    </header>
    <div className="batch-validation-range">
      <label className="field-stack"><span className="field-label">开始 (秒)</span>
        <input type="number" className="text-input num" aria-label="验收开始时间" min={0} max={available ? duration : 0}
          step="any" value={from} disabled={busy} onChange={event => setFrom(event.target.value)} /></label>
      <label className="field-stack"><span className="field-label">结束 (秒)</span>
        <input type="number" className="text-input num" aria-label="验收结束时间" min={0} max={available ? duration : 0}
          step="any" value={to} disabled={busy} onChange={event => setTo(event.target.value)} /></label>
      <label className="field-stack"><span className="field-label">抽样间隔</span>
        <select className="text-input num" aria-label="验收抽样间隔" value={step} disabled={busy}
          onChange={event => setStep(Number(event.target.value))}>
          {[0.5, 1, 2, 5].map(value => <option key={value} value={value}>{value}s</option>)}
        </select></label>
      {/* Stop can finish during click dispatch. Never turn its live DOM node into a submitter. */}
      {running ? <button key="stop" type="button" className="btn-solid" onClick={onStop}>停止验收</button>
        : <button key="start" type="button" className="btn-solid" disabled={!!rangeError || busy} onClick={() => {
          if (!rangeError && !busy) { setPage(0); onStart({ from: start, to: end, step }) }
        }}>{state.run ? '重新验收' : '开始验收'}</button>}
      <div className="batch-validation-range-tools">
        <button type="button" className="btn-quiet small" disabled={!available || busy} onClick={() => setFrom(String(currentTime))}>当前位置为开始</button>
        <button type="button" className="btn-quiet small" disabled={!available || busy} onClick={() => setTo(String(currentTime))}>当前位置为结束</button>
        <button type="button" className="btn-quiet small" disabled={!available || busy}
          onClick={() => { setFrom('0'); setTo(String(duration)) }}>选择全片</button>
        {!rangeError && <span className="muted num">预计 {planned} 帧</span>}
      </div>
    </div>
    {rangeError && <p className="note-warn" role="note">{rangeError}</p>}
    <p className="muted">按间隔抽样, 不含结束时刻, 可能漏过短暂事件. 读取成功率和置信度不是准确率, 未发现疑点也需要抽查.</p>
    <p className="muted">已关闭字段不参与判定. 切镜头或倒计时被替换时, 缺少有效读数记为未判定, 不作为识别错误或正确样本.</p>
    {state.run && <div className="batch-validation-progress">
      <p className="batch-validation-snapshot">快照: {state.run.packName} / {state.run.packId} / revision {state.run.packRevision}</p>
      <p className="muted">录像: {state.run.sourceName} / {time(state.run.from)} - {time(state.run.to)} / 每 {state.run.step}s</p>
      <progress aria-label="验收进度" max={Math.max(1, state.run.total)} value={Math.min(state.rows.length, state.run.total)} />
      <p role="status" aria-live="polite">{status}: {state.rows.length} / {state.run.total} 帧</p>
    </div>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {state.rows.length > 0 && <>
      <div className="batch-validation-summary" aria-label="验收统计">
        <p>已抽样 <b className="num">{summary.sampled}</b> 帧 / 疑点 <b className="num">{summary.issueFrames}</b> 帧 / 未判定 <b className="num">{summary.unavailableFrames}</b> 帧 / 状态记录 <b className="num">{summary.transitionFrames}</b> 帧</p>
        <div className="batch-validation-field-stats">{HUD_FIELD_IDS.map(id => {
          const field = summary.fields[id]
          return <div key={id}><span>{FIELD_LABELS[id]}</span>
            <strong className="num">{field.attempted ? `${(field.read / field.attempted * 100).toFixed(1)}%` : '--'}</strong>
            <span className="muted">读取成功 {field.read}/{field.attempted}</span>
            <span className="muted">未出现 {field.absent} / 已关闭 {field.disabled}</span></div>
        })}</div>
        <p className="muted">分母按已配置的数字字段读取尝试统计, 未读出不等于读错; 未出现和已关闭单独列出. 没有人工真值, 本结果不代表准确率.</p>
      </div>
      <div className="batch-validation-filters" role="group" aria-label="验收结果筛选">
        {([['issues', '疑点'], ['transitions', '状态与未判定'], ['all', '全部']] as const).map(([value, label]) =>
          <button type="button" key={value} className="btn-quiet small" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        <span className="muted">{filtered.length} 条结果</span>
      </div>
      {visible.length ? <>
        <div className="batch-validation-columns" aria-hidden="true"><span>录像时间</span><span>倒计时</span><span>左 / 右比分</span><span>画面与布局</span><span>检查结果</span></div>
        <ul className="batch-validation-results" aria-label="验收结果">
          {visible.map(row => <li key={row.index}><button type="button" className="batch-validation-row"
            data-issue={row.notes.some(note => note.kind === 'issue') || undefined} aria-label={`查看 ${time(row.at)} 验收结果`}
            aria-pressed={selected?.index === row.index} aria-controls={detailsId} disabled={busy} onClick={() => onInspect(row.index)}>
            <span className="num">{time(row.at)}</span>
            <span className="num">{reading(row.fields.clock)}</span>
            <span className="num">{reading(row.fields.scoreLeft)} / {reading(row.fields.scoreRight)}</span>
            <span>{CONTENT[row.content]} / {PHASE[row.phase]}<small>{row.layout ?? '没有匹配布局'}</small></span>
            <span>{row.notes.length ? row.notes.map(note => note.message).join(' / ')
              : validationUnavailable(row) ? '未取得完整有效观测, 未作正误判定' : '未发现规则疑点'}</span>
          </button></li>)}
        </ul>
        <nav className="batch-validation-pages" aria-label="验收结果分页">
          <button type="button" className="btn-quiet small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span className="num">第 {currentPage + 1} / {pages} 页</span>
          <button type="button" className="btn-quiet small" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </nav>
      </> : <p className="batch-validation-empty muted">{filter === 'issues'
        ? '当前抽样未发现疑点, 不代表准确率 100%. 可切换到全部结果抽查.' : '当前筛选没有结果.'}</p>}
    </>}
    {selected && <section className="batch-validation-detail" id={detailsId} aria-label="验收帧详情">
      <header className="batch-validation-head"><h3>{time(selected.at)} / {selected.layout ?? '没有匹配布局'}</h3>
        <button type="button" className="btn-quiet small" disabled={busy} onClick={() => onJump(selected.at)}>回到此帧</button></header>
      <p>{CONTENT[selected.content]} / {PHASE[selected.phase]}</p>
      <dl className="batch-validation-readings">{HUD_FIELD_IDS.map(id => {
        const field = selected.fields[id]
        return <div key={id}><dt>{FIELD_LABELS[id]}</dt>
          <dd>{reading(field)}{field.confidence !== null ? ` / 置信度 ${field.confidence.toFixed(3)}` : ''}
            {field.reason ? ` / ${field.reason}` : ''}</dd></div>
      })}</dl>
      <dl className="batch-validation-readings">{[...HUD_CUE_IDS, 'organizer' as const].map(id => {
        const cue = selected.cues[id]
        return cue ? <div key={id}><dt>{CUE_LABELS[id]}</dt><dd>{cueText(cue)}{cue.reason ? ` / ${cue.reason}` : ''}</dd></div> : null
      })}</dl>
      {selected.notes.length > 0 && <ul className="batch-validation-notes" aria-label="当前帧检查记录">
        {selected.notes.map((note, index) => <li key={index} data-kind={note.kind}><b>{note.kind === 'issue' ? '疑点' : '观测'} / {TARGET[note.target]}</b> {note.message}</li>)}
      </ul>}
      {state.previewBusy && <p className="muted" role="status">正在读取原始画面...</p>}
      {preview && <div className="batch-validation-pictures">{preview.images.map((image, index) => <figure key={`${image.target}-${index}`}
        className={image.target === 'frame' ? 'is-full-frame' : undefined}>
        <figcaption>{image.label} / {image.width}x{image.height}</figcaption>
        <img src={image.url} alt={`${image.label}原始画面`} width={image.width} height={image.height} loading="lazy" />
      </figure>)}</div>}
      {!preview && !state.previewBusy && <p className="muted">点击结果行读取原始裁切, 只查看不会改动样式包.</p>}
    </section>}
  </section>
}
