import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DOUYU_LOTTERY_POLL_MS, type DouyuLotterySnapshot } from '../../../server/douyu/douyuLotteryTypes'
import type { ChatMessage } from '../../../server/danmaku/types'
import type { ApiResult } from '../../app/apiClient'
import { Switch } from '../kit'
import './douyuLottery.css'

export type DouyuLotteryCommandMessage = Pick<ChatMessage, 'room' | 'text' | 'receivedAt'> & Partial<Pick<ChatMessage, 'platform' | 'system' | 'gift'>>

export function matchDouyuLotteryCommand(snapshot: DouyuLotterySnapshot | null, observedAt: number, message: DouyuLotteryCommandMessage): string | null {
  const activity = snapshot?.activity
  if (snapshot?.status !== 'active' || snapshot.serverNow === null || activity?.joinType !== 1 || !activity.command
    || message.room !== activity.room || message.room !== snapshot.room || (message.platform && message.platform !== 'douyu')
    || message.system || message.gift || message.text !== activity.command) return null
  const elapsed = message.receivedAt - observedAt
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= DOUYU_LOTTERY_POLL_MS) return null
  const receivedServerAt = snapshot.serverNow + elapsed
  return receivedServerAt >= activity.startsAt && receivedServerAt < activity.endsAt ? activity.id : null
}

export interface DouyuLotteryActions {
  read: (room: string) => Promise<ApiResult<DouyuLotterySnapshot>>
  openOfficialRoom: (room: string, activityId: string) => Promise<ApiResult<{ opened: boolean }>>
  notify: (text: string) => () => void
}

interface Observation {
  snapshot: DouyuLotterySnapshot
  wallAt: number
  monotonicAt: number
}

const reminded = new Set<string>()

export function useDouyuLottery(room: string | null, connected: boolean, actions: DouyuLotteryActions) {
  const [observation, setObservation] = useState<Observation | null>(null)
  const [clock, setClock] = useState(() => performance.now())
  const [remindersEnabled, setRemindersEnabled] = useState(false)
  const latest = useRef(actions)
  latest.current = actions
  const activeRoom = room && /^[1-9][0-9]{0,11}$/.test(room) ? room : null

  useEffect(() => {
    setObservation(null)
    if (!activeRoom || !connected) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const result = await Promise.resolve().then(() => latest.current.read(activeRoom)).catch(() => null)
      if (!live) return
      const monotonicAt = performance.now()
      setClock(monotonicAt)
      const snapshot: DouyuLotterySnapshot = result?.ok && result.value.room === activeRoom ? result.value
        : { room: activeRoom, status: 'unavailable', activity: null, serverNow: null }
      setObservation({ snapshot, monotonicAt, wallAt: Date.now() })
      timer = setTimeout(() => { void poll() }, DOUYU_LOTTERY_POLL_MS)
    }
    void poll()
    return () => { live = false; clearTimeout(timer) }
  }, [activeRoom, connected])

  const current = connected && observation?.snapshot.room === activeRoom ? observation : null
  const snapshot = current?.snapshot
  const remainingMs = current && snapshot?.activity && snapshot.serverNow !== null
    ? Math.max(0, snapshot.activity.endsAt - snapshot.serverNow - Math.max(0, clock - current.monotonicAt)) : 0
  const activity = remainingMs > 0 && snapshot?.status === 'active' ? snapshot.activity : null
  const activityKey = activity ? `${activity.room}:${activity.id}` : null
  useEffect(() => {
    if (!activityKey) return
    const timer = setInterval(() => setClock(performance.now()), 500)
    return () => clearInterval(timer)
  }, [activityKey])
  useEffect(() => {
    if (!remindersEnabled || !activityKey || !activity || reminded.has(activityKey) || reminded.size >= 512) return
    reminded.add(activityKey)
    return latest.current.notify(`斗鱼主播抽奖 ${activity.prize}，参与条件可在官方房间查看`)
  }, [activityKey, remindersEnabled])

  return {
    activity, remainingMs, remindersEnabled, setRemindersEnabled,
    phase: !connected || !activeRoom ? 'disconnected' : activity ? 'active'
      : snapshot?.status === 'unavailable' ? 'unavailable' : snapshot ? 'empty' : 'loading',
    matchCommand: (message: DouyuLotteryCommandMessage) => current && activity
      ? matchDouyuLotteryCommand(current.snapshot, current.wallAt, message) : null,
    openOfficialRoom: actions.openOfficialRoom,
  }
}

export type DouyuLotteryView = ReturnType<typeof useDouyuLottery>

export function DouyuLotteryCard({ view }: { view: DouyuLotteryView }): ReactNode {
  const activity = view.activity
  return <section className="douyu-lottery" aria-label="斗鱼主播抽奖">
    <div className="douyu-lottery-head"><strong>主播抽奖</strong>
      <Switch label="抽奖提醒" checked={view.remindersEnabled} onChange={view.setRemindersEnabled} />
    </div>
    {activity ? <LotteryDetails key={`${activity.room}:${activity.id}`} view={view} activity={activity} />
      : <p className="douyu-lottery-note">{view.phase === 'loading' ? '正在读取当前房间抽奖'
        : view.phase === 'disconnected' ? '连接房间后检测主播抽奖'
          : view.phase === 'unavailable' ? '抽奖状态或官方时间暂时无法确认' : '当前没有进行中的主播抽奖'}</p>}
  </section>
}

function LotteryDetails({ view, activity }: { view: DouyuLotteryView; activity: NonNullable<DouyuLotteryView['activity']> }): ReactNode {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)
  const seconds = Math.ceil(view.remainingMs / 1000)
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  const cost = activity.cost
  const open = async () => {
    setOpening(true)
    setError(false)
    try {
      const result = await view.openOfficialRoom(activity.room, activity.id)
      setError(!result.ok || !result.value.opened)
    } catch { setError(true) }
    finally { setOpening(false) }
  }
  return <>
    <p className="douyu-lottery-prize">{activity.prize}{activity.prizeCount !== null && `（${activity.prizeCount} 份）`}</p>
    <p className="douyu-lottery-time">开奖倒计时 <time aria-label="真实开奖倒计时">{countdown}</time><small>不随视频延时</small></p>
    <ul>{activity.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul>
    {activity.joinType === 1 && activity.command && <p>官方口令 <span className="douyu-lottery-command">{activity.command}</span></p>}
    {activity.gift && <p>赠礼条件：{activity.gift.count ?? '待确认'} 个 {activity.gift.name ?? `礼物 ${activity.gift.id ?? '待确认'}`}
      {cost ? `，礼物标价 ${cost.totalMinor / cost.scale} ${cost.currency === 'YUCHI' ? '鱼翅' : '鱼丸'}`
        : `，赠礼成本待官方确认${activity.gift.priceOriginal ? `，官方价格原文：${activity.gift.priceOriginal}` : ''}`}
    </p>}
    <p className="douyu-lottery-note">账号资格请在官方房间核对</p>
    <button type="button" className="btn-quiet small" disabled={opening} onClick={() => { void open() }}>
      {opening ? '正在打开' : '打开官方房间'}
    </button>
    {error && <p role="status">官方入口暂时无法打开，请确认活动仍在进行</p>}
  </>
}

export function DouyuLotteryCommandGroup({ count, children }: { count: number; children: ReactNode }): ReactNode {
  return <details className="douyu-lottery-command-group">
    <summary>{count} 条疑似抽奖口令</summary>
    {children}
  </details>
}
