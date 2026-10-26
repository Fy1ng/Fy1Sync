/**
 * One gift plan at a time, from preview to result.
 *
 * Gifting spends real items or currency, so the order is fixed: the main process builds a
 * plan from what was asked, the viewer sees that exact plan, and only an explicit confirm
 * executes it — by plan id, never by resending the inputs. A plan is single use. It is
 * retired the moment anything it was built from changes (the caller calls `discard`), when
 * the account changes, and when the page goes away. Nothing here retries: an unknown
 * outcome stays unknown until the viewer checks the official room.
 *
 * The main process keeps a single gift plan slot, so the backpack and the purchase form
 * share one instance of this hook; a new preview from either replaces the other.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { DouyuGiftPlan, DouyuGiftResult } from '../../../server/douyu/inventoryTypes'

export const GIFT_RESULT: Record<DouyuGiftResult['status'], string> = {
  completed: '处理完成', 'waiting-user': '部分结果需要核对', cancelled: '剩余操作已停止', failed: '未完成',
}

type Phase = 'plan' | 'give' | null

/** Retiring a plan never gives anything, so a failed retire is not the viewer's problem. */
const retire = (planId: string): void => {
  try { void apiClient.feature('cancelDouyuGiftPlan', { planId }).catch(() => {}) } catch { /* ignore */ }
}

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Structural checks every plan must pass before it may be shown as confirmable. */
export function planShapeOk(value: unknown, accountId: string, room: string, kind: DouyuGiftPlan['kind']): value is DouyuGiftPlan {
  const plan = value as DouyuGiftPlan | null
  if (!plan || typeof plan.id !== 'string' || !plan.id || plan.accountId !== accountId || plan.room !== room || plan.kind !== kind) return false
  if (!Array.isArray(plan.rows) || plan.rows.length === 0 || !Array.isArray(plan.excludedItems)) return false
  if (typeof plan.expiresAt !== 'number' || !whole(plan.intervalMs) || !whole(plan.totalQuantity) || !whole(plan.totalOperations)) return false
  if (plan.rows.some((row) => !whole(row.quantity) || row.quantity < 1 || !whole(row.repeat) || row.repeat < 1)) return false
  const operations = plan.rows.reduce((sum, row) => sum + row.repeat, 0)
  const quantity = plan.rows.reduce((sum, row) => sum + row.quantity * row.repeat, 0)
  return operations === plan.totalOperations && quantity === plan.totalQuantity && plan.totalQuantity > 0
}

function resultOk(value: unknown, planId: string): value is DouyuGiftResult {
  const result = value as DouyuGiftResult | null
  return !!result && result.planId === planId && result.status in GIFT_RESULT && Array.isArray(result.rows)
    && whole(result.submittedQuantity) && whole(result.confirmedQuantity)
}

export function useGiftPlan(accountId: string | null) {
  const [plan, setPlan] = useState<DouyuGiftPlan | null>(null)
  const [used, setUsed] = useState(false)
  const [result, setResult] = useState<DouyuGiftResult | null>(null)
  const [busy, setBusy] = useState<Phase>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)

  const mounted = useRef(false)
  const generation = useRef(0)
  const phase = useRef<Phase>(null)
  const live = useRef<{ id: string; used: boolean } | null>(null)
  const running = useRef<string | null>(null)
  const owner = useRef(accountId)

  /** Drop every plan and pending reply, and stop a running plan; nothing in flight may land. */
  const abandon = useCallback(() => {
    generation.current++
    if (running.current) retire(running.current)
    running.current = null
    if (live.current && !live.current.used) retire(live.current.id)
    live.current = null
    phase.current = null
  }, [])

  const reset = useCallback(() => {
    abandon()
    setPlan(null); setUsed(false); setResult(null); setBusy(null); setStopping(false); setError('')
  }, [abandon])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; abandon() }
  }, [abandon])

  useLayoutEffect(() => {
    if (owner.current === accountId) return
    owner.current = accountId
    reset()
  }, [accountId, reset])

  const expired = plan !== null && !used && plan.expiresAt <= now
  useEffect(() => {
    if (!plan || used || expired) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [plan, used, expired])

  /** Any edit after a preview: the plan no longer describes what is on screen. */
  const discard = useCallback(() => {
    // Inputs are locked while a plan runs; the running plan is only stopped explicitly.
    if (running.current) return
    generation.current++
    if (live.current && !live.current.used) retire(live.current.id)
    live.current = null
    phase.current = null
    setPlan(null); setUsed(false); setResult(null); setBusy(null); setError('')
  }, [])

  const preview = useCallback(async (
    run: () => Promise<ApiResult<DouyuGiftPlan>>,
    accepts: (value: unknown) => value is DouyuGiftPlan,
  ): Promise<void> => {
    if (!accountId || phase.current || running.current) return
    discard()
    const mine = ++generation.current
    phase.current = 'plan'
    setBusy('plan')
    try {
      const response = await run()
      const id = response.ok && typeof response.value?.id === 'string' ? response.value.id : null
      if (!mounted.current || mine !== generation.current) { if (id) retire(id); return }
      if (!response.ok) { setError(response.message); return }
      if (!accepts(response.value)) { if (id) retire(id); throw new Error('bad plan') }
      live.current = { id: response.value.id, used: false }
      setPlan(response.value)
      setNow(Date.now())
    } catch {
      if (mounted.current && mine === generation.current) setError('预览未能生成，请重新生成。')
    } finally {
      if (mine === generation.current) phase.current = null
      if (mounted.current && mine === generation.current) setBusy(null)
    }
  }, [accountId, discard])

  const give = useCallback(async (): Promise<void> => {
    const current = live.current
    if (!plan || !current || current.used || current.id !== plan.id || plan.accountId !== accountId
      || plan.expiresAt <= Date.now() || phase.current || running.current) return
    // Marked before anything awaits, so a second click cannot send a second execute.
    current.used = true
    running.current = plan.id
    phase.current = 'give'
    const mine = ++generation.current
    setUsed(true); setBusy('give'); setError(''); setResult(null); setStopping(false)
    try {
      // The reviewed plan is the whole command; the inputs are never resent.
      const response = await apiClient.feature('executeDouyuGiftPlan', { planId: plan.id })
      if (!mounted.current || mine !== generation.current) return
      if (!response.ok) { setError(response.message); return }
      if (!resultOk(response.value, plan.id)) throw new Error('bad result')
      setResult(response.value)
    } catch {
      if (mounted.current && mine === generation.current) setError('无法确认赠送结果。请在官方直播间和背包中核对，此处不会自动重试。')
    } finally {
      if (running.current === plan.id) running.current = null
      if (mine === generation.current) phase.current = null
      if (mounted.current && mine === generation.current) { setBusy(null); setStopping(false) }
    }
  }, [plan, accountId])

  const stop = useCallback(async (): Promise<void> => {
    const id = running.current
    if (!id || stopping) return
    setStopping(true)
    try {
      const response = await apiClient.feature('cancelDouyuGiftPlan', { planId: id })
      if (mounted.current && running.current === id && !response.ok) { setError(response.message); setStopping(false) }
    } catch {
      if (mounted.current && running.current === id) { setError('停止请求未确认，请在结果返回后核对。'); setStopping(false) }
    }
  }, [stopping])

  return { plan, used, result, busy, stopping, error, expired, now, preview, discard, reset, give, stop }
}

export type GiftPlanHandle = ReturnType<typeof useGiftPlan>
