/**
 * Keeping fan badges alive by giving glow sticks already in the backpack.
 *
 * Four steps, and the order is the safety: read the badges, choose rooms and amounts, check
 * the exact plan the main process built from the current backpack, then give. Only the
 * reviewed plan is ever executed — the inputs are not resent — and a plan dies the moment
 * anything it was built from changes: the selection, an amount, the account, its expiry,
 * or this page closing. Nothing here buys, claims or retries.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { DouyuRenewalPlan, DouyuRenewalResult, DouyuRenewalTargetPage } from '../../../server/douyu/renewalTypes'

const MAX_ROOMS = 20
const ROW_STATE = { 'receipt-received': '已收到回执', unknown: '需要核对', 'not-submitted': '没有送出', skipped: '跳过' } as const
const RESULT = { completed: '处理完了', 'waiting-user': '有结果需要你核对', cancelled: '剩下的已停止', failed: '没有完成' } as const

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
    setPage(null); setPicked([]); setAmount('1'); setOverrides({}); setFilter('')
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
      if (mounted.current && mine === generation.current) setError('读不到粉丝牌，稍后再试')
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
    const base = amountOf(amount)
    if (!accountId || busy || base === null || picked.length === 0) return
    const quantities: { room: string; quantity: number }[] = []
    for (const room of picked) {
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
      const response = await apiClient.previewDouyuRenewal({ accountId, rooms, quantity: base, ...(quantities.length ? { quantities } : {}) })
      if (!mounted.current || mine !== generation.current) {
        if (response.ok && typeof response.value?.id === 'string') retire(response.value.id)
        return
      }
      if (!response.ok) { setError(response.message); return }
      const value = response.value
      const total = value?.rows?.reduce((sum, row) => sum + (row.status === 'ready' && row.gift ? row.gift.quantity : 0), 0)
      if (!value || value.accountId !== accountId || typeof value.id !== 'string' || !Array.isArray(value.rows)
        || value.rows.length !== rooms.length || value.rows.some((row) => !rooms.includes(row.room)) || total !== value.totalQuantity) {
        if (typeof value?.id === 'string') retire(value.id)
        throw new Error('bad plan')
      }
      livePlan.current = { id: value.id, used: false }
      setPlan(value)
      setNow(Date.now())
    } catch {
      if (mounted.current && mine === generation.current) setError('核对单没有生成，稍后再试')
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
      if (mounted.current && mine === generation.current) setError('结果确认不了。去官方背包和房间核对一下，这里不会重试。')
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
      if (mounted.current && running.current === id) { setError('停止没有确认，等结果出来再核对'); setStopping(false) }
    }
  }

  const query = filter.trim().toLocaleLowerCase()
  const shown = page?.targets.filter((target) => target.room.includes(query) || target.badgeName.toLocaleLowerCase().includes(query)) ?? []
  const base = amountOf(amount)
  const badOverride = picked.some((room) => overrides[room] !== undefined && overrides[room] !== '' && amountOf(overrides[room]!) === null)
  const readyRows = plan?.rows.filter((row) => row.status === 'ready') ?? []
  const canGive = ready && !!plan && !livePlan.current?.used && !expired && plan.accountId === accountId && plan.totalQuantity > 0 && !busy

  if (!accountId) return <div className="desk-pane"><p className="desk-empty">先在「账号」里登录并设一个在用的账号。</p></div>

  return (
    <div className="desk-pane renewal">
      <p className="muted">只送背包里已有的荧光棒，不买、不领。送多少自己定，1 个不一定够续上。</p>

      <ol className="steps">
        <li className="step" data-done={page !== null}>
          <div className="step-head">
            <h3>读粉丝牌</h3>
            <button type="button" className={page ? 'btn-quiet small' : 'btn-solid small'} disabled={!ready || !!busy} onClick={() => void read()}>
              {busy === 'read' ? '读取中…' : page ? '重新读' : `读 ${accountLabel} 的粉丝牌`}
            </button>
          </div>
          {!ready && !busy && <p className="muted">先登录 {accountLabel}，登好后就能读。</p>}
          {page && page.coverage !== 'all-pages' && <p className="muted">这只是{page.coverage === 'official-snapshot' ? '官方当前的快照' : '返回的这一页'}，不一定是全部粉丝牌。</p>}
        </li>

        {page && (
          <li className="step" data-done={picked.length > 0}>
            <div className="step-head">
              <h3>选房间</h3>
              <span className="num muted">{picked.length}/{MAX_ROOMS}</span>
            </div>
            {page.targets.length === 0 ? <p className="muted">没有可选的粉丝牌。</p> : (
              <>
                <div className="renew-tools">
                  <input type="search" className="text-input" value={filter} placeholder="房间号或牌子名" aria-label="筛选粉丝牌"
                    onChange={(event) => setFilter(event.target.value)} />
                  <label className="renew-amount">
                    <span>每个房间送</span>
                    <input className="text-input num" type="number" min={1} max={1000} value={amount} disabled={locked}
                      aria-label="每个房间赠送数量" aria-invalid={base === null}
                      onChange={(event) => { invalidate(); setAmount(event.target.value) }} />
                    <span>个</span>
                  </label>
                </div>
                {base === null && <p className="form-error">填 1 到 1000 的整数</p>}
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
                        {on && (
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
                {badOverride && <p className="form-error">有房间的数量不对，填 1 到 1000 或留空</p>}
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
                        : <span className="muted">跳过：{row.reason ?? '现在送不了'}</span>}
                    </li>
                  ))}
                </ul>
                {!livePlan.current?.used && (expired
                  ? <p className="form-error">核对单过期了，重新生成</p>
                  : <p className="muted">核对单 {Math.max(0, Math.ceil((plan.expiresAt - now) / 1000))} 秒后过期</p>)}
              </section>
            )}
          </li>
        )}

        {plan && (
          <li className="step" data-done={result !== null}>
            <div className="step-head">
              <h3>赠送</h3>
              {busy === 'give'
                ? <button type="button" className="btn-quiet small" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停…' : '停下剩下的'}</button>
                : <button type="button" className="btn-solid small" disabled={!canGive} onClick={() => void give()}>确认赠送</button>}
            </div>
            {result && (
              <section aria-label="赠送处理结果" className="plan">
                <p><b>{RESULT[result.status]}</b><span className="muted">　回执不代表续期一定成功</span></p>
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
    </div>
  )
}
