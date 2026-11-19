import { useRef, useState, type ReactNode } from 'react'
import { Switch } from '../kit'
import type { DouyinLotteryActivity, DouyinLotteryTarget } from '../../core/douyinLottery'
import type { DouyinLotteryActions, DouyinLotteryView } from './useDouyinLottery'
import './douyinLottery.css'

const statuses = {
  loading: '正在读取当前场次的普通福袋.',
  empty: '当前未检测到进行中的普通福袋.',
  unavailable: '暂时无法确认普通福袋状态.',
  disconnected: '弹幕连接恢复后检测普通福袋.',
} as const

export function DouyinLotteryCard({ view }: { view: DouyinLotteryView }): ReactNode {
  const { activity, remaining, phase } = view
  return <section className="douyin-lottery" aria-label="抖音普通福袋">
    <header>
      <strong>抖音普通福袋</strong>
      {activity && <span className="num" aria-label="普通福袋开奖倒计时">
        {Math.floor(remaining / 60).toString().padStart(2, '0')}:{(remaining % 60).toString().padStart(2, '0')}
      </span>}
    </header>
    {activity && view.roomId ? <>
      <LotteryDetails activity={activity} />
      {view.openOfficial && <OpenOfficial key={`${view.connectionKey}:${view.room}:${view.roomId}:${activity.id}`}
        action={view.openOfficial} input={{ room: view.room, roomId: view.roomId, activityId: activity.id }} />}
    </> : <p className="muted">{statuses[phase === 'active' ? 'unavailable' : phase]}</p>}
    {(activity?.commentCommand || view.foldComments) && <Switch label="折叠福袋同文"
      detail="同文可能含正常聊天, 可随时展开."
      checked={view.foldComments} onChange={view.setFoldComments} />}
    {view.canRemind && <Switch label="普通福袋提醒" detail="每轮活动提醒一次"
      checked={view.reminders} onChange={view.setReminders} />}
  </section>
}

function LotteryDetails({ activity }: { activity: DouyinLotteryActivity }): ReactNode {
  const { prize, conditions, webSupport } = activity
  return <>
    <p><strong>{prize.name}</strong></p>
    <p className="muted">
      {prize.kind === 'virtual-currency' ? '虚拟币奖励' : '实物奖品'}
      {prize.count !== null && ` / 奖励数量 ${prize.count}`}
      {prize.winners !== null && ` / 中奖名额 ${prize.winners}`}
    </p>
    {prize.description && <p>{prize.description}</p>}
    {conditions.length > 0 && <ul aria-label="福袋参与条件">{conditions.map(({ label }, index) => <li key={index}>{label}</li>)}</ul>}
    <p className="muted">参与资格请在官方直播间确认.</p>
    {webSupport === 'app-may-be-required' && <p>此条件组合可能需要抖音 App.</p>}
  </>
}

function OpenOfficial({ action, input }: {
  action: NonNullable<DouyinLotteryActions['openOfficial']>
  input: DouyinLotteryTarget & { activityId: string }
}): ReactNode {
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const open = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await action(input)
      if (!result.ok) setProblem(result.message)
    } catch {
      setProblem('暂时无法打开官方直播间.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return <>
    <button type="button" className="douyin-lottery-open" disabled={busy} onClick={() => { void open() }}>
      打开官方直播间查看福袋
    </button>
    {problem && <p role="alert">{problem}</p>}
  </>
}
