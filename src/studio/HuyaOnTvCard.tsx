import { useEffect, useState } from 'react'
import type { HuyaOnTvSnapshot } from '../../server/platforms/huyaOnTv'
import { huyaOnTvFresh, huyaOnTvRemaining } from '../core/huyaOnTv'
import { Switch } from './kit'
import './HuyaOnTvCard.css'

export interface HuyaOnTvCardProps {
  room: string | null
  snapshot: HuyaOnTvSnapshot | null
  connected: boolean
  reminders: boolean
  onRemindersChange: (enabled: boolean) => void
  openOfficialRoom?: (room: string) => Promise<{ ok: true } | { ok: false; message: string }>
}

export function HuyaOnTvCard(props: HuyaOnTvCardProps) {
  const { room } = props
  if (!room || !/^huya:[1-9]\d{0,15}$/.test(room)) return null
  return <HuyaOnTvRoomCard key={room} {...props} room={room} />
}

function HuyaOnTvRoomCard({ room, snapshot, connected, reminders, onRemindersChange, openOfficialRoom }:
  HuyaOnTvCardProps & { room: string }) {
  const [now, setNow] = useState(Date.now)
  const [problem, setProblem] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const panel = connected && snapshot?.room === room ? snapshot : null
  useEffect(() => {
    setNow(Date.now())
    if (!panel || panel.status === 'unavailable' || panel.status === 'loading') return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [panel])

  const stale = panel !== null && !huyaOnTvFresh(panel, Math.max(now, panel.observedAt))
  const activity = stale ? null : panel?.activity
  const remaining = huyaOnTvRemaining(panel, now)
  const active = activity && panel?.status === 'active' && remaining > 0
  const status = !connected ? '连接恢复后继续检测'
    : stale || panel?.status === 'unavailable' ? '活动状态暂不可用, 等待更新'
      : panel?.status === 'none' ? '当前未检测到上电视'
        : active ? null : activity ? '本轮已结束, 请查看官方结果' : '正在检测上电视...'

  const open = async () => {
    if (!openOfficialRoom || opening) return
    setProblem(null)
    setOpening(true)
    try {
      const result = await openOfficialRoom(room)
      if (!result.ok) setProblem(result.message)
    } catch {
      setProblem('暂时无法打开虎牙官方房间, 请重试.')
    } finally {
      setOpening(false)
    }
  }

  return <section className="huya-on-tv-card" aria-label="虎牙上电视">
    <div className="huya-on-tv-head">
      <strong>虎牙上电视</strong>
      {active && <span className="num" aria-label="上电视开奖倒计时">
        {Math.floor(remaining / 60).toString().padStart(2, '0')}:{(remaining % 60).toString().padStart(2, '0')} 开奖
      </span>}
    </div>
    {status && <p role="status">{status}</p>}
    {activity && <>
      {activity.title && <p>{activity.title}</p>}
      <p className="huya-on-tv-prize">奖品: {activity.prize || '请查看官方奖品说明'}</p>
      <p>{activity.cost}</p>
      <p className="huya-on-tv-conditions">{activity.conditions.join('. ')}</p>
    </>}
    <Switch label="上电视活动提醒" checked={reminders} onChange={onRemindersChange} />
    {openOfficialRoom && <button type="button" className="btn" disabled={opening} onClick={() => void open()}>
      打开虎牙官方房间
    </button>}
    {problem && <p role="alert">{problem}</p>}
  </section>
}

export function HuyaRoomWatchStatus({ room }: { room: string | null }) {
  if (!room || !/^huya:[1-9]\d{0,15}$/.test(room)) return null
  return <section className="huya-on-tv-card" aria-label="虎牙本房观看">
    <strong>本房官方今日及累计观看时长未验证</strong>
    <p>当前没有可核验的个人观时读数. 虎牙 App 的 我的 &gt; 历史/收藏 &gt; 看过 可查询浏览记录.</p>
    <p>个人看播任务进度请在虎牙 App 的任务中心或活动页查看.</p>
  </section>
}
