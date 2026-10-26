/**
 * Keeping fan badges alive by giving glow sticks already in the backpack.
 *
 * Four steps, and the order is the safety: read the badges, choose rooms and amounts, check
 * the exact plan the main process built from the current backpack, then give. Only the
 * reviewed plan is ever executed — the inputs are not resent — and a plan dies the moment
 * anything it was built from changes: the selection, an amount, the account, its expiry,
 * or this page closing. Nothing here buys, claims or retries.
 *
 * Amounts come one of three ways: one number for every room, a number per room, or an
 * equal split of each kind of eligible item the main process finds (the remainder stays in
 * the backpack and is shown as such).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuRenewalPlan, DouyuRenewalResult, DouyuRenewalTargetPage } from '../../../server/douyu/renewalTypes'
import { Segmented } from '../kit'
import { BadgeAges } from './BadgeAges'
import './backpack.css'

const MAX_ROOMS = 20
const ROW_STATE = { 'receipt-received': '已收到回执', unknown: '需要核对', 'not-submitted': '未送出', skipped: '跳过' } as const
const RESULT = { completed: '处理完成', 'waiting-user': '部分结果需要核对', cancelled: '其余已停止', failed: '未完成' } as const
type Allocation = 'uniform' | 'per-room' | 'equal'
const ALLOCATIONS: { value: Allocation; label: string }[] = [
  { value: 'uniform', label: '统一数量' }, { value: 'per-room', label: '逐房数量' }, { value: 'equal', label: '同类库存均分' },
]

const amountOf = (text: string): number | null => {
  const value = Number(text)
  return text.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 1000 ? value : null
}
const nameOf = ({ room, badgeName }: { room: string; badgeName: string }): string =>
  !badgeName.trim() || badgeName === room || badgeName === `房间 ${room}` ? `房间 ${room}` : badgeName
const time = (value: number | null): string => value === null ? '不过期'
  : Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知'

/** Retiring a plan never gives anything, so failures here are not the viewer's problem. */
const retire = (planId: string): void => { try { void apiClient.cancelDouyuRenewal(planId).catch(() => {}) } catch { /* ignore */ } }

export function Renewal({ accountId, accountLabel, ready }: { accountId: string | null; accountLabel: string; ready: boolean }): React.ReactNode {
  const [page, setPage] = useState<DouyuRenewalTargetPage | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [amount, setAmount] = useState('1')
  const [allocation, setAllocation] = useState<Allocation>('uniform')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [plan, setPlan] = useState<DouyuRenewalPlan | null>(null)
  const [result, setResult] = useState<DouyuRenewalResult | null>(null)
  const [busy, setBusy] = useState<'read' | 'plan' | 'give' | null>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)

  const mounted = useRef(false)
  const generation = useRef(0)
  const livePlan = useRef<{ id: string; used: boolean } | null>(null)
  const running = useRef<string | null>(null)
  const owner = useRef(accountId)

  /** Drop every plan and pending reply; nothing that was in flight may land afterwards. */
  const abandon = useCallback(() => {
    generation.current++
    if (running.current) retire(running.current)
    running.current = null
    if (livePlan.current && !livePlan.current.used) retire(livePlan.current.id)
    livePlan.current = null
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; abandon() }
  }, [abandon])

  useLayoutEffect(() => {
    if (owner.current === accountId) return
    abandon()
    owner.current = accountId
    setPage(null); setPicked([]); setAmount('1'); setAllocation('uniform'); setOverrides({}); setFilter('')
    setPlan(null); setResult(null); setBusy(null); setStopping(false); setError('')
  }, [accountId, abandon])

  const expired = plan !== null && !livePlan.current?.used && plan.expiresAt <= now
  useEffect(() => {
    if (!plan || livePlan.current?.used || expired) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [plan, expired])

  /** Any edit after a preview: the plan no longer describes what is on screen. */
  const invalidate = (): void => {
    if (livePlan.current && !livePlan.current.used) retire(livePlan.current.id)
    livePlan.current = null
    setPlan(null)
    setResult(null)
  }

  const locked = !ready || !accountId || busy === 'give' || busy === 'read'

  const read = async (): Promise<void> => {
    if (!accountId || busy) return
    invalidate()
    const mine = ++generation.current
    setBusy('read'); setError('')
    try {
      const response = await apiClient.getDouyuRenewalTargets(accountId)
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      if (value?.accountId !== accountId || !Array.isArray(value.targets)) throw new Error('bad page')
      const rooms = new Set(value.targets.map((target) => target.room))
      setPage(value)
      setPicked((current) => current.filter((room) => rooms.has(room)))
      setOverrides((current) => Object.fromEntries(Object.entries(current).filter(([room]) => rooms.has(room))))
    } catch {
      if (mounted.current && mine === generation.current) setError('无法读取粉丝牌，请稍后重试')
    } finally {
      if (mounted.current && mine === generation.current) setBusy(null)
    }
  }

  const toggle = (room: string, on: boolean): void => {
    if (locked) return
    const next = on ? [...picked, room] : picked.filter((item) => item !== room)
    if (next.length > MAX_ROOMS) { setError(`一次最多 ${MAX_ROOMS} 个房间`); return }
    invalidate(); setError('')
    setPicked(next)
  }

  const preview = async (): Promise<void> => {
    const equal = allocation === 'equal'
    const base = equal ? 1 : amountOf(amount)
    if (!accountId || busy || base === null || picked.length === 0) return
    const quantities: { room: string; quantity: number }[] = []
    if (allocation === 'per-room') for (const room of picked) {
      const text = overrides[room]
      if (text === undefined || text === '') continue
      const value = amountOf(text)
      if (value === null) return
      quantities.push({ room, quantity: value })
    }
    invalidate()
    const mine = ++generation.current
    const rooms = [...picked]
    setBusy('plan'); setError('')
    try {
      const response = equal
        ? await apiClient.feature('previewDouyuRenewalEqual', { accountId, rooms })
        : await apiClient.previewDouyuRenewal({ accountId, rooms, quantity: base, ...(quantities.length ? { quantities } : {}) })
      if (!mounted.current || mine !== generation.current) {
        if (response.ok && typeof response.value?.id === 'string') retire(response.value.id)
        return
      }
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      const total = value?.rows?.reduce((sum, row) => sum + (row.status === 'ready' && row.gift ? row.gift.quantity : 0), 0)
      if (!value || value.accountId !== accountId || typeof value.id !== 'string' || !Array.isArray(value.rows)
        || value.rows.length !== rooms.length || value.rows.some((row) => !rooms.includes(row.room)) || total !== value.totalQuantity
        || (equal && (value.allocation?.mode !== 'equal-per-prop' || !Array.isArray(value.allocation.leftovers)))) {
        if (typeof value?.id === 'string') retire(value.id)
        throw new Error('bad plan')
      }
      livePlan.current = { id: value.id, used: false }
      setPlan(value)
      setNow(Date.now())
    } catch {
      if (mounted.current && mine === generation.current) setError('核对单生成失败，请稍后重试')
    } finally {
      if (mounted.current && mine === generation.current) setBusy(null)
    }
  }

  const give = async (): Promise<void> => {
    const current = livePlan.current
    if (!plan || !current || current.used || current.id !== plan.id || plan.accountId !== accountId
      || plan.totalQuantity <= 0 || plan.expiresAt <= Date.now() || busy) return
    current.used = true
    running.current = plan.id
    const mine = ++generation.current
    setBusy('give'); setError(''); setResult(null); setStopping(false)
    try {
      // The reviewed plan is the whole command; the inputs above are never resent.
      const response = await apiClient.executeDouyuRenewal(plan.id)
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      if (!value || value.planId !== plan.id || !(value.status in RESULT) || !Array.isArray(value.rows)) throw new Error('bad result')
      setResult(value)
    } catch {
      if (mounted.current && mine === generation.current) setError('无法确认结果。请在官方背包和直播间中核对，此处不会自动重试。')
    } finally {
      if (running.current === plan.id) running.current = null
      if (mounted.current && mine === generation.current) { setBusy(null); setStopping(false) }
    }
  }

  const stop = async (): Promise<void> => {
    const id = running.current
    if (!id || stopping) return
    setStopping(true)
    try {
      const response = await apiClient.cancelDouyuRenewal(id)
      if (mounted.current && running.current === id && !response.ok) { setError(response.message); setStopping(false) }
    } catch {
      if (mounted.current && running.current === id) { setError('停止请求未确认，请在结果返回后核对'); setStopping(false) }
    }
  }

  const query = filter.trim().toLocaleLowerCase()
  const shown = page?.targets.filter((target) => target.room.includes(query) || target.badgeName.toLocaleLowerCase().includes(query)) ?? []
  const base = allocation === 'equal' ? 1 : amountOf(amount)
  const badOverride = allocation === 'per-room'
    && picked.some((room) => overrides[room] !== undefined && overrides[room] !== '' && amountOf(overrides[room]!) === null)
  const readyRows = plan?.rows.filter((row) => row.status === 'ready') ?? []
  const canGive = ready && !!plan && !livePlan.current?.used && !expired && plan.accountId === accountId && plan.totalQuantity > 0 && !busy
  const propName = (propId: string): string => plan?.rows.find((row) => row.gift?.propId === propId)?.gift?.name ?? `道具 ${propId}`
  const leftovers = plan?.allocation?.leftovers.filter((item) => item.quantity > 0) ?? []

  if (!accountId) return <div className="desk-pane"><p className="desk-empty">请先在「账号」中登录并设置当前账号。</p></div>

  return (
    <div className="desk-pane renewal">
      <p className="muted">仅赠送背包中已有的荧光棒，不会购买或领取。赠送数量自行设定，1 个不一定足以续期。</p>

      <ol className="steps">
        <li className="step" data-done={page !== null}>
          <div className="step-head">
            <h3>读取粉丝牌</h3>
            <button type="button" className={page ? 'btn-quiet small' : 'btn-solid small'} disabled={!ready || !!busy} onClick={() => void read()}>
              {busy === 'read' ? '读取中…' : page ? '重新读取' : `读取 ${accountLabel} 的粉丝牌`}
            </button>
          </div>
          {!ready && !busy && <p className="muted">请先登录 {accountLabel}，登录后即可读取。</p>}
          {page && page.coverage !== 'all-pages' && <p className="muted">以上为{page.coverage === 'official-snapshot' ? '官方当前快照' : '本次返回的一页'}，可能不包含全部粉丝牌。</p>}
        </li>

        {page && (
          <li className="step" data-done={picked.length > 0}>
            <div className="step-head">
              <h3>选择房间</h3>
              <span className="num muted">{picked.length}/{MAX_ROOMS}</span>
            </div>
            {page.targets.length === 0 ? <p className="muted">没有可选的粉丝牌。</p> : (
              <>
                <div className="renew-mode">
                  <Segmented<Allocation> label="数量分配方式" value={allocation} options={ALLOCATIONS} disabled={locked}
                    onChange={(value) => { if (locked) return; invalidate(); setError(''); setAllocation(value) }} />
                </div>
                {allocation === 'equal' && <p className="muted">将背包中每种合格道具平均分给使用该道具的所选房间，单房最多 1000 个，余数留在背包。</p>}
                <div className="renew-tools">
                  <input type="search" className="text-input" value={filter} placeholder="房间号或牌子名" aria-label="筛选粉丝牌"
                    onChange={(event) => setFilter(event.target.value)} />
                  {allocation !== 'equal' && <label className="renew-amount">
                    <span>{allocation === 'per-room' ? '未填写的房间赠送' : '每个房间赠送'}</span>
                    <input className="text-input num" type="number" min={1} max={1000} value={amount} disabled={locked}
                      aria-label="每个房间赠送数量" aria-invalid={base === null}
                      onChange={(event) => { invalidate(); setAmount(event.target.value) }} />
                    <span>个</span>
                  </label>}
                </div>
                {base === null && <p className="form-error">请填写 1 到 1000 的整数</p>}
                {allocation === 'per-room' && <p className="muted">为所选房间分别填写数量，留空的房间按上方数量赠送。</p>}
                <ul className="badges">
                  {shown.map((target) => {
                    const on = picked.includes(target.room)
                    const text = overrides[target.room] ?? ''
                    const bad = on && text !== '' && amountOf(text) === null
                    return (
                      <li key={target.room} className="badge-row" data-on={on}>
                        <label className="badge-pick">
                          <input type="checkbox" checked={on} disabled={locked || (!on && picked.length >= MAX_ROOMS)}
                            aria-label={`选择房间 ${target.room} (${target.badgeName})`}
                            onChange={(event) => toggle(target.room, event.target.checked)} />
                          <span className="badge-name">{nameOf(target)}</span>
                          <span className="num muted">{target.room}</span>
                        </label>
                        {on && allocation === 'per-room' && (
                          <input className="text-input num badge-qty" type="number" min={1} max={1000} value={text} disabled={locked}
                            placeholder={base === null ? '—' : String(base)} aria-label={`房间 ${target.room} 的赠送数量`} aria-invalid={bad}
                            onChange={(event) => {
                              invalidate()
                              const value = event.target.value
                              setOverrides((current) => {
                                const next = { ...current }
                                if (value === '') delete next[target.room]
                                else next[target.room] = value
                                return next
                              })
                            }} />
                        )}
                      </li>
                    )
                  })}
                  {shown.length === 0 && <li className="muted">没有匹配的牌子</li>}
                </ul>
                {badOverride && <p className="form-error">部分房间数量无效，请填写 1 到 1000 或留空</p>}
              </>
            )}
          </li>
        )}

        {page && picked.length > 0 && (
          <li className="step" data-done={plan !== null}>
            <div className="step-head">
              <h3>核对</h3>
              <button type="button" className={plan ? 'btn-quiet small' : 'btn-solid small'}
                disabled={!ready || !!busy || base === null || badOverride} onClick={() => void preview()}>
                {busy === 'plan' ? '生成中…' : plan ? '重新生成' : '生成核对单'}
              </button>
            </div>
            {plan && (
              <section aria-label="赠送预览" className="plan">
                <p>用 <b className="num">{plan.totalQuantity}</b> 个背包道具，送给 <b className="num">{readyRows.length}</b> 个房间</p>
                <ul className="plan-rows">
                  {plan.rows.map((row) => (
                    <li key={row.room} data-state={row.status}>
                      <span>{nameOf(row)}</span>
                      {row.status === 'ready' && row.gift
                        ? <span className="num">{row.gift.name} × {row.gift.quantity}<span className="muted">（库存 {row.gift.stock}，{time(row.gift.expiresAt)}）</span></span>
                        : <span className="muted">跳过：{row.reason ?? '当前无法赠送'}</span>}
                    </li>
                  ))}
                </ul>
                {plan.allocation && (
                  <p className="renew-leftovers">
                    留在背包：{leftovers.length ? leftovers.map((item) => `${propName(item.propId)} × ${item.quantity}`).join('，') : '无'}
                  </p>
                )}
                {!livePlan.current?.used && (expired
                  ? <p className="form-error">核对单已过期，请重新生成</p>
                  : <p className="muted">核对单 {Math.max(0, Math.ceil((plan.expiresAt - now) / 1000))} 秒后过期</p>)}
              </section>
            )}
          </li>
        )}

        {plan && (
          <li className="step" data-done={result !== null}>
            <div className="step-head">
              <h3>赠送</h3>
              {/* Confirm stays mounted (disabled) while giving, so a double click's second
                  press cannot land on the stop button that would otherwise take its place. */}
              <button key="give" type="button" className="btn-solid small" disabled={!canGive} onClick={() => void give()}>确认赠送</button>
              {busy === 'give' && (
                <button key="stop" type="button" className="btn-quiet small" disabled={stopping} onClick={() => void stop()}>
                  {stopping ? '正在停止…' : '停止剩余赠送'}
                </button>
              )}
            </div>
            {result && (
              <section aria-label="赠送处理结果" className="plan">
                <p><b>{RESULT[result.status]}</b><span className="muted">　收到回执不代表续期成功</span></p>
                <ul className="plan-rows">
                  {result.rows.map((row) => (
                    <li key={row.room} data-state={row.status}>
                      <span>{nameOf(row)}</span>
                      <span>{ROW_STATE[row.status]}{row.propName ? ` · ${row.propName} × ${row.quantity}` : ''}<span className="muted"> {row.message}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </li>
        )}
      </ol>
      {error && <p className="form-error" role="alert">{error}</p>}
      <BadgeAges accountId={accountId} ready={ready} />
    </div>
  )
}
