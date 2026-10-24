import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../app/apiClient'
import type { DouyuRenewalPlan, DouyuRenewalResult, DouyuRenewalTargetPage } from '../../server/douyu/renewalTypes'
import './DouyuRenewalPanel.css'

export interface DouyuRenewalPanelProps {
  accountId: string | null
  accountLabel: string
  disabled?: boolean
}

type Work = { kind: 'targets' | 'preview' | 'execute'; accountId: string; generation: number }
type BoundPlan = { data: DouyuRenewalPlan; revision: number; consumed: boolean }
type Execution = { work: Work; planId: string; cancelRequested: boolean; cancelPending: boolean }

const MAX_ROOMS = 20
const RESULT_LABELS = {
  'receipt-received': '收到赠送回执', unknown: '需要核对', 'not-submitted': '未提交', skipped: '已跳过',
} as const
const RESULT_TITLES = { completed: '赠送处理完成', 'waiting-user': '赠送结果需要核对', cancelled: '已停止剩余赠送', failed: '赠送未完成' } as const
const RESULT_REASONS: Record<NonNullable<DouyuRenewalResult['reason']>, string> = {
  'plan-changed': '预览已过期或目标与库存已变化, 请重新生成预览.',
  'inventory-changed': '库存变化与计划不一致, 剩余操作已停止, 请在官方房间核对.',
  'account-changed': '账号状态已变化, 请核对下表后重新读取目标.',
  unconfirmed: '赠送结果未能确认, 剩余房间未继续处理.',
  cancelled: '剩余操作已停止. 已可能提交的项目仍需核对.',
  'queue-busy': '执行队列正忙, 请等待当前操作结束后重新预览.',
  unavailable: '当前条件或返回信息无法确认, 未继续执行剩余操作.',
}
const quantityOf = (value: string) => value.trim() && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 1000 ? Number(value) : null
const targetLabel = ({ room, badgeName }: { room: string; badgeName: string }) => badgeName === `房间 ${room}` || badgeName === room
  ? `房间 ${room}` : `${badgeName} / 房间 ${room}`
const expiryLabel = (value: number | null) => value === null ? '永久' : Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知'

/** Cancellation here only retires main-process plans; it never creates another gift. */
function cancelQuietly(planId: string): void {
  try { void apiClient.cancelDouyuRenewal(planId).catch(() => {}) } catch { /* Cleanup cannot interrupt account changes or unmount. */ }
}

export function DouyuRenewalPanel({ accountId, accountLabel, disabled = false }: DouyuRenewalPanelProps): React.ReactNode {
  const [page, setPage] = useState<DouyuRenewalTargetPage | null>(null)
  const [rooms, setRooms] = useState<string[]>([])
  const [quantityText, setQuantityText] = useState('1')
  const [plan, setPlanState] = useState<BoundPlan | null>(null)
  const [result, setResult] = useState<DouyuRenewalResult | null>(null)
  const [busy, setBusy] = useState<Work['kind'] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(Date.now)
  const mounted = useRef(false)
  const identity = useRef(accountId)
  const disabledRef = useRef(disabled)
  const generation = useRef(0)
  const revision = useRef(0)
  const selected = useRef<string[]>([])
  const quantity = useRef('1')
  const boundPlan = useRef<BoundPlan | null>(null)
  const work = useRef<Work | null>(null)
  const execution = useRef<Execution | null>(null)

  const replacePlan = useCallback((next: BoundPlan | null) => {
    boundPlan.current = next
    setPlanState(next)
  }, [])

  const abandon = useCallback(() => {
    const running = execution.current
    if (running && !running.cancelRequested && !running.cancelPending) {
      running.cancelRequested = true
      cancelQuietly(running.planId)
    }
    const previous = boundPlan.current
    if (previous && !previous.consumed) cancelQuietly(previous.data.id)
    execution.current = null
    work.current = null
    boundPlan.current = null
    generation.current++
    revision.current++
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; abandon() }
  }, [abandon])

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (identity.current === accountId) return
    abandon()
    identity.current = accountId
    selected.current = []
    quantity.current = '1'
    setPage(null)
    setRooms([])
    setQuantityText('1')
    setPlanState(null)
    setResult(null)
    setBusy(null)
    setError('')
    setNotice('')
    setStopping(false)
  }, [accountId, disabled, abandon])

  const planExpired = plan !== null && !plan.consumed && plan.data.expiresAt <= now
  useEffect(() => {
    if (!plan || plan.consumed || planExpired) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [plan, planExpired])

  const isCurrent = (request: Work) => mounted.current && work.current === request
    && generation.current === request.generation && identity.current === request.accountId
  const startWork = (kind: Work['kind']): Work | null => {
    if (!mounted.current || !identity.current || disabledRef.current || work.current) return null
    const request = { kind, accountId: identity.current, generation: generation.current }
    work.current = request
    setBusy(kind)
    setError('')
    setNotice('')
    return request
  }
  const finishWork = (request: Work) => {
    if (work.current !== request) return
    work.current = null
    if (mounted.current) setBusy(null)
  }
  const invalidatePlan = () => {
    revision.current++
    const previous = boundPlan.current
    if (previous && !previous.consumed) cancelQuietly(previous.data.id)
    replacePlan(null)
    setResult(null)
  }

  const readTargets = async () => {
    const request = startWork('targets')
    if (!request) return
    invalidatePlan()
    try {
      const response = await apiClient.getDouyuRenewalTargets(request.accountId)
      if (!isCurrent(request)) return
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      if (value?.accountId !== request.accountId || value.coverage !== 'returned-page' || !Array.isArray(value.targets)
        || value.targets.some(target => typeof target?.room !== 'string' || typeof target.badgeName !== 'string')
        || new Set(value.targets.map(target => target.room)).size !== value.targets.length) throw new Error('Invalid target page')
      setPage(value)
      selected.current = []
      setRooms([])
    } catch {
      if (isCurrent(request)) setError('无法读取粉丝牌, 请稍后重试.')
    } finally { finishWork(request) }
  }

  const changeRooms = (next: string[]) => {
    if (disabledRef.current || execution.current || work.current?.kind === 'targets') return
    if (next.length > MAX_ROOMS) { setError('每次最多选择 20 个房间, 请减少选择.'); return }
    invalidatePlan()
    selected.current = next
    setRooms(next)
    setError('')
    setNotice('选择已变化, 请重新生成赠送预览.')
  }
  const changeQuantity = (next: string) => {
    if (disabledRef.current || execution.current || work.current?.kind === 'targets') return
    invalidatePlan()
    quantity.current = next
    setQuantityText(next)
    setNotice('数量已变化, 请重新生成赠送预览.')
  }

  const preview = async () => {
    const count = quantityOf(quantity.current)
    if (count === null || !selected.current.length || selected.current.length > MAX_ROOMS) return
    const request = startWork('preview')
    if (!request) return
    invalidatePlan()
    const config = revision.current
    const targetRooms = [...selected.current]
    try {
      const response = await apiClient.previewDouyuRenewal({ accountId: request.accountId, rooms: targetRooms, quantity: count })
      if (!isCurrent(request) || config !== revision.current) {
        if (response.ok && typeof response.value?.id === 'string') cancelQuietly(response.value.id)
        return
      }
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      if (!value || value.accountId !== request.accountId || typeof value.id !== 'string' || !value.id
        || !Number.isFinite(value.expiresAt) || !Number.isSafeInteger(value.totalQuantity) || value.totalQuantity < 0
        || !Array.isArray(value.rows) || value.rows.length !== targetRooms.length
        || new Set(value.rows.map(row => row.room)).size !== value.rows.length
        || value.rows.some(row => !targetRooms.includes(row.room) || typeof row.badgeName !== 'string'
          || !['ready', 'skipped'].includes(row.status)
          || row.status === 'ready' && (!row.gift || typeof row.gift.name !== 'string' || !Number.isSafeInteger(row.gift.quantity)
            || row.gift.quantity <= 0 || !Number.isSafeInteger(row.gift.stock) || row.gift.stock < row.gift.quantity))
        || value.rows.reduce((sum, row) => sum + (row.status === 'ready' ? row.gift!.quantity : 0), 0) !== value.totalQuantity) throw new Error('Invalid plan')
      replacePlan({ data: value, revision: config, consumed: false })
      setNow(Date.now())
    } catch {
      if (isCurrent(request) && config === revision.current) setError('无法生成赠送预览, 请稍后重试.')
    } finally { finishWork(request) }
  }

  const cancelPreview = () => {
    if (execution.current) return
    invalidatePlan()
    setError('')
    setNotice('赠送预览已取消.')
  }

  const confirm = async () => {
    const current = boundPlan.current
    if (!current || current.consumed || current.revision !== revision.current || current.data.accountId !== identity.current
      || current.data.totalQuantity <= 0 || current.data.expiresAt <= Date.now()) return
    const request = startWork('execute')
    if (!request) return
    const run: Execution = { work: request, planId: current.data.id, cancelRequested: false, cancelPending: false }
    execution.current = run
    replacePlan({ ...current, consumed: true })
    setResult(null)
    setStopping(false)
    try {
      // The reviewed plan is the entire command. Never reconstruct its gifts from inputs.
      const response = await apiClient.executeDouyuRenewal(run.planId)
      if (!isCurrent(request)) return
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      if (!value || value.planId !== run.planId || !Object.hasOwn(RESULT_TITLES, value.status) || !Array.isArray(value.rows)
        || value.rows.some(row => !Object.hasOwn(RESULT_LABELS, row.status))) throw new Error('Invalid execution result')
      setResult(value)
      setNotice('')
    } catch {
      if (isCurrent(request)) setError('赠送结果尚无法确认. 请核对官方背包和已处理的房间, 本面板不会自动重试.')
    } finally {
      if (execution.current === run) {
        execution.current = null
        if (mounted.current) setStopping(false)
      }
      finishWork(request)
    }
  }

  const stop = async () => {
    const run = execution.current
    if (!run || run.cancelPending || run.cancelRequested) return
    run.cancelPending = true
    setStopping(true)
    setError('')
    try {
      const response = await apiClient.cancelDouyuRenewal(run.planId)
      if (execution.current !== run || !isCurrent(run.work)) return
      if (!response.ok) { setError(response.message); return }
      run.cancelRequested = response.value.cancelled
      setNotice(response.value.cancelled ? '已请求停止, 正在等待赠送处理结果.' : '停止状态尚未确认, 请等待赠送处理结果并核对.')
    } catch {
      if (execution.current === run && isCurrent(run.work)) setError('无法确认停止状态. 请等待处理结果, 或再次手动停止.')
    } finally {
      run.cancelPending = false
      if (execution.current === run && mounted.current) setStopping(run.cancelRequested)
    }
  }

  const configuredQuantity = quantityOf(quantityText)
  const selectionLocked = disabled || !accountId || busy === 'execute' || busy === 'targets'
  const readyRows = plan?.data.rows.filter(row => row.status === 'ready') ?? []
  const mayConfirm = !disabled && !!accountId && !busy && !!plan && !plan.consumed && !planExpired
    && plan.revision === revision.current && plan.data.accountId === accountId && plan.data.totalQuantity > 0 && readyRows.length > 0

  return <details className="douyu-renewal-panel">
    <summary>续牌赠送</summary>
    <div className="douyu-renewal-body">
      <p>当前账号: {accountId ? accountLabel : '未选择'}</p>
      <p className="douyu-renewal-hint">使用当前背包中已有的普通荧光棒, 不购买, 不领取或特殊兑换. 所需数量请自行确认, 1 个不保证足够续期.</p>
      <p className="douyu-renewal-hint">仅显示本次返回页, 不代表全部粉丝牌. 离开此面板将停止剩余操作, 折叠本节不停止.</p>
      {!accountId && <p className="douyu-renewal-hint">请先登录并激活斗鱼账号.</p>}
      <div className="douyu-renewal-actions">
        <button type="button" disabled={disabled || !accountId || !!busy} onClick={() => { void readTargets() }}>读取粉丝牌</button>
      </div>
      {page && <fieldset className="douyu-renewal-targets" disabled={selectionLocked}>
        <legend>本页粉丝牌目标</legend>
        <p className="douyu-renewal-hint">已选择 {rooms.length}/20 个房间.</p>
        {page.targets.length === 0 ? <p>本次返回页没有可选目标.</p> : <>
          <div className="douyu-renewal-actions">
            <button type="button" disabled={page.targets.length > MAX_ROOMS} onClick={() => changeRooms(page.targets.map(target => target.room))}>全选本页</button>
            <button type="button" disabled={rooms.length === 0} onClick={() => changeRooms([])}>清空选择</button>
          </div>
          {page.targets.length > MAX_ROOMS && <p className="douyu-renewal-hint">本页超过 20 个房间, 请逐个选择, 不会自动截取前 20 个.</p>}
          <div className="douyu-renewal-target-list">
            {page.targets.map(target => <label key={target.room}>
              <input type="checkbox" checked={rooms.includes(target.room)} disabled={!rooms.includes(target.room) && rooms.length >= MAX_ROOMS}
                aria-label={`选择房间 ${target.room} (${target.badgeName})`}
                onChange={event => changeRooms(event.target.checked ? [...selected.current, target.room] : selected.current.filter(room => room !== target.room))} />
              <span>{targetLabel(target)}</span>
            </label>)}
          </div>
        </>}
      </fieldset>}
      <label className="douyu-renewal-quantity"><span>每个房间赠送数量</span>
        <input type="number" min={1} max={1000} step={1} value={quantityText} disabled={selectionLocked} onChange={event => changeQuantity(event.target.value)} />
      </label>
      {configuredQuantity === null && <p className="douyu-renewal-error">数量必须为 1 至 1000 的整数.</p>}
      <div className="douyu-renewal-actions">
        <button type="button" disabled={disabled || !accountId || !!busy || !rooms.length || rooms.length > MAX_ROOMS || configuredQuantity === null}
          onClick={() => { void preview() }}>生成赠送预览</button>
        {(plan && !plan.consumed || busy === 'preview') && <button type="button" onClick={cancelPreview}>取消预览</button>}
      </div>
      {plan && <section className="douyu-renewal-plan" aria-label="赠送预览">
        <p>计划使用 {plan.data.totalQuantity} 个现有背包道具, 赠送至 {readyRows.length} 个房间.</p>
        <p className="douyu-renewal-hint">赠送回执不等于续期效果已验证.</p>
        <ul>{plan.data.rows.map(row => <li key={row.room}>
          <strong>{targetLabel(row)}</strong>
          {row.status === 'ready' && row.gift ? <>
            <span>{row.gift.name} x {row.gift.quantity}, 读取时库存 {row.gift.stock}</span>
            <span>道具到期: {expiryLabel(row.gift.expiresAt)}</span>
          </> : <span>已跳过: {row.reason ?? '当前不可赠送'}</span>}
        </li>)}</ul>
        {!plan.consumed && <p className="douyu-renewal-hint">预览有效期至: {expiryLabel(plan.data.expiresAt)}</p>}
        {planExpired && <p className="douyu-renewal-error">赠送预览已过期, 请重新生成预览.</p>}
        <button type="button" disabled={!mayConfirm} onClick={() => { void confirm() }}>确认赠送</button>
      </section>}
      {busy === 'execute' && <div className="douyu-renewal-actions">
        <button type="button" disabled={stopping} onClick={() => { void stop() }}>停止赠送</button>
      </div>}
      {busy && <p className="douyu-renewal-hint" role="status">{busy === 'targets' ? '正在读取本页粉丝牌...' : busy === 'preview' ? '正在生成赠送预览...' : '正在处理已确认的赠送...'}</p>}
      {notice && <p className="douyu-renewal-hint" role="status">{notice}</p>}
      {error && <p className="douyu-renewal-error" role="alert">{error}</p>}
      {result && <section className="douyu-renewal-result" aria-label="赠送处理结果">
        <strong>{RESULT_TITLES[result.status]}</strong>
        {result.reason && Object.hasOwn(RESULT_REASONS, result.reason) && <p className="douyu-renewal-hint">{RESULT_REASONS[result.reason]}</p>}
        <p className="douyu-renewal-hint">赠送回执不等于续期效果已验证. 请按房间核对已处理和未提交的项目.</p>
        <ul>{result.rows.map(row => <li key={row.room} data-state={row.status}>
          <strong>{targetLabel(row)}</strong>
          <span>{RESULT_LABELS[row.status]}{row.propName ? ` / ${row.propName} x ${row.quantity}` : ''}</span>
          <span>{row.message}</span>
        </li>)}</ul>
      </section>}
    </div>
  </details>
}
