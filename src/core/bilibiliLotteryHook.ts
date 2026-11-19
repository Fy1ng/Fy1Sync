import { useCallback, useEffect, useRef, useState } from 'react'
import { BILIBILI_LOTTERY_FRESH_MS, BILIBILI_LOTTERY_POLL_MS,
  type BilibiliLotteryClient, type BilibiliLotterySnapshot, type BilibiliLotteryWatch } from './bilibiliLottery'
import type { SourceRole } from './types'

export interface BilibiliLotteryHookOptions {
  client: BilibiliLotteryClient
  slot: SourceRole
  input: string
  reconnectKey?: string
  onSnapshot?: (snapshot: BilibiliLotterySnapshot) => void
  onReminder?: (snapshot: BilibiliLotterySnapshot) => void
}

export function useBilibiliLottery({ client, slot, input, reconnectKey, onSnapshot, onReminder }: BilibiliLotteryHookOptions) {
  const [snapshot, setSnapshot] = useState<BilibiliLotterySnapshot | null>(null)
  const [history, setHistory] = useState<BilibiliLotterySnapshot[]>([])
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [reminders, setRemindersState] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const [, setTick] = useState(0)
  const callbacks = useRef({ onSnapshot, onReminder })
  callbacks.current = { onSnapshot, onReminder }
  const receipt = useRef<{ monotonic: number; age: number } | null>(null)
  const lifecycle = useRef<{ watch: BilibiliLotteryWatch; stopped: boolean; reminders: boolean; cancel: () => void } | null>(null)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => client.subscribeFeatures?.(event => {
    if (event.topic !== 'bilibili-lottery-invalidated') return
    lifecycle.current?.cancel()
    receipt.current = null
    setSnapshot(null); setHistory([]); setRemindersState(false)
    setEpoch(value => value + 1)
  }), [client])

  useEffect(() => {
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = { slot, watchId: crypto.randomUUID() }
    const current = { watch, stopped: false, reminders: false, cancel: () => {
      if (current.stopped) return
      current.stopped = true
      if (timer) clearTimeout(timer)
      void client.feature('stopBilibiliLottery', watch).catch(() => {})
    } }
    lifecycle.current = current
    receipt.current = null
    setSnapshot(null); setHistory([]); setProblem(''); setRemindersState(false)
    const read = async () => {
      if (current.stopped || pending) return
      if (timer) clearTimeout(timer)
      pending = true; setBusy(true)
      let cancelled = false
      try {
        const result = await client.feature('readBilibiliLottery', { ...watch, input, reminders: current.reminders })
        if (current.stopped) return
        if (result.ok) {
          const age = Date.now() - result.value.checkedAt
          receipt.current = { monotonic: performance.now(), age: age >= 0 ? age : Infinity }
          setSnapshot(result.value); setProblem('')
          setHistory(previous => [...previous.filter(item => item.checkedAt !== result.value.checkedAt), result.value].slice(-512))
          callbacks.current.onSnapshot?.(result.value)
          const remaining = result.value.endsAt !== null && result.value.serverNow !== null
            ? result.value.endsAt - result.value.serverNow - age : null
          if (result.value.reminder && current.reminders && age >= 0 && age <= BILIBILI_LOTTERY_FRESH_MS
            && result.value.phase === 'ongoing' && remaining !== null
            && remaining > (result.value.clockUncertaintyMs ?? Infinity)) callbacks.current.onReminder?.(result.value)
        } else {
          receipt.current = null; setSnapshot(null); setProblem(result.message)
          cancelled = result.code === 'cancelled'
        }
      } catch {
        if (!current.stopped) { receipt.current = null; setSnapshot(null); setProblem('暂时无法读取B站活动.') }
      } finally {
        pending = false
        if (!current.stopped) {
          setBusy(false)
          timer = setTimeout(() => {
            if (cancelled) setEpoch(value => value + 1)
            else void read()
          }, BILIBILI_LOTTERY_POLL_MS)
        }
      }
    }
    refreshRef.current = () => { void read() }
    const online = () => { void read() }
    window.addEventListener('online', online)
    const clock = setInterval(() => setTick(value => value + 1), 500)
    void read()
    return () => {
      current.cancel(); clearInterval(clock); window.removeEventListener('online', online)
      if (lifecycle.current === current) lifecycle.current = null
    }
  }, [client, slot, input, epoch])

  useEffect(() => { refreshRef.current() }, [reconnectKey])
  const refresh = useCallback(() => refreshRef.current(), [])
  const setReminders = useCallback(async (enabled: boolean) => {
    const current = lifecycle.current
    if (!current || current.stopped) return
    current.reminders = enabled; setRemindersState(enabled)
    try {
      const result = await client.feature('setBilibiliLotteryReminders', { ...current.watch, enabled })
      if (current.stopped || lifecycle.current !== current || current.reminders !== enabled) return
      if (!result.ok) { current.reminders = false; setRemindersState(false); setProblem(result.message) }
      else refreshRef.current()
    } catch {
      if (!current.stopped && lifecycle.current === current && current.reminders === enabled) {
        current.reminders = false; setRemindersState(false); setProblem('无法设置B站活动提醒.')
      }
    }
  }, [client])
  const open = useCallback(async () => {
    const current = lifecycle.current
    if (!current || current.stopped || !snapshot?.room) return
    try {
      const result = await client.feature('openBilibiliLotteryRoom', { ...current.watch, room: snapshot.room, activityId: snapshot.activity?.id ?? null })
      if (!current.stopped && !result.ok) setProblem(result.message)
    } catch { if (!current.stopped) setProblem('无法打开B站官方直播间.') }
  }, [client, snapshot])

  const elapsed = receipt.current ? receipt.current.age + performance.now() - receipt.current.monotonic : Infinity
  const stale = elapsed < 0 || elapsed > BILIBILI_LOTTERY_FRESH_MS
  const remaining = !stale && snapshot?.serverNow !== null && snapshot?.serverNow !== undefined
    && snapshot.endsAt !== null ? Math.max(0, snapshot.endsAt - snapshot.serverNow - elapsed) : null
  const phase = snapshot ? stale ? 'unverified' : snapshot.phase === 'ongoing' && remaining === 0 ? 'ended' : snapshot.phase : null
  return { snapshot, history, problem, busy, reminders, setReminders, refresh, open, remaining, phase, stale }
}
