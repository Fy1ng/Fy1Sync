import { useEffect, useRef, useState } from 'react'
import {
  DOUYIN_LOTTERY_POLL_MS,
  douyinLotteryRemaining,
  matchDouyinLotteryComment,
  type DouyinLotteryComment,
  type DouyinLotterySnapshot,
  type DouyinLotteryTarget,
} from '../../core/douyinLottery'
import { douyinMessageRoom } from '../../core/douyinMessage'

export interface DouyinLotteryActions {
  read: (room: string, signal: AbortSignal) => Promise<DouyinLotterySnapshot | null>
  openOfficial?: (input: DouyinLotteryTarget & { activityId: string }) => Promise<{ ok: true } | { ok: false; message: string }>
  notify?: (message: string) => void
}

interface Observation {
  connectionKey: string | number
  room: string
  snapshot: DouyinLotterySnapshot | null
  monotonicAt: number
  elapsedMs: number
}

const reminded = new Set<string>()

export function useDouyinLottery(
  inputRoom: string | null,
  connectionKey: string | number | null,
  actions: DouyinLotteryActions,
) {
  const room = douyinMessageRoom(inputRoom) ? inputRoom : null
  const [observation, setObservation] = useState<Observation | null>(null)
  const [clock, setClock] = useState(() => performance.now())
  const [foldComments, setFoldComments] = useState(false)
  const [reminders, setReminders] = useState(false)
  const latest = useRef(actions)
  latest.current = actions

  useEffect(() => {
    setObservation(null)
    if (!room || connectionKey === null) return
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const response = await Promise.resolve().then(() => signal.aborted ? null : latest.current.read(room, signal)).catch(() => null)
      if (signal.aborted) return
      const snapshot = response?.room === room ? response : null
      const monotonicAt = performance.now()
      setObservation({
        connectionKey, room, snapshot, monotonicAt,
        elapsedMs: snapshot ? Math.max(0, Date.now() - snapshot.observedAt) : 0,
      })
      setClock(monotonicAt)
      timer = setTimeout(() => { void poll() }, DOUYIN_LOTTERY_POLL_MS)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [room, connectionKey])

  const current = observation?.room === room && observation.connectionKey === connectionKey ? observation : null
  const snapshot = current?.snapshot ?? null
  const remaining = current && snapshot?.status === 'active'
    ? douyinLotteryRemaining(snapshot.activity, current.elapsedMs + Math.max(0, clock - current.monotonicAt))
    : 0
  const activity = snapshot?.status === 'active' && remaining > 0 ? snapshot.activity : null
  const activityKey = activity && snapshot ? `${snapshot.room}:${snapshot.roomId}:${activity.id}` : null

  useEffect(() => {
    if (!activityKey) return
    const timer = setInterval(() => setClock(performance.now()), 250)
    return () => clearInterval(timer)
  }, [activityKey])

  useEffect(() => {
    if (!reminders || !activityKey || !activity || !latest.current.notify || reminded.has(activityKey) || reminded.size >= 4096) return
    reminded.add(activityKey)
    latest.current.notify(`抖音普通福袋：${activity.prize.name}，参与资格请在官方直播间确认`)
  }, [activityKey, activity, reminders])

  const phase = connectionKey === null ? 'disconnected'
    : activity ? 'active'
    : !current ? 'loading'
    : !snapshot || snapshot.status === 'unavailable' ? 'unavailable' : 'empty'

  return room ? {
    room, connectionKey, phase, activity, remaining,
    roomId: snapshot?.roomId ?? null,
    foldComments, setFoldComments,
    reminders, setReminders,
    canRemind: Boolean(actions.notify),
    matchComment: (message: DouyinLotteryComment) => matchDouyinLotteryComment(snapshot, message),
    openOfficial: actions.openOfficial,
  } as const : null
}

export type DouyinLotteryView = NonNullable<ReturnType<typeof useDouyinLottery>>
