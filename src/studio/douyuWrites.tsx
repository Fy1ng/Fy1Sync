/**
 * The experimental gate for everything that acts on Douyu as the viewer: sending, +1, reply,
 * mute, gifts, room and batch tasks, badge renewal. Off by default for the first release;
 * reading (accounts, followed rooms, the backpack, spending, records) never depends on it.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { Switch } from './kit'

export function useDouyuWrites(): boolean {
  return useSessionSnapshot().settings.douyuWrites
}

/** The switch, with the risk spelled out before it turns on. */
export function DouyuWritesPane(): React.ReactNode {
  const session = useSession()
  const on = useDouyuWrites()
  const [asking, setAsking] = useState(false)
  return (
    <div className="desk-pane">
      <Switch label="斗鱼写操作（实验性）" detail="发送弹幕、+1、回复、禁言、赠礼、续牌，以及签到、鱼吧签到、定时弹幕、钓鱼、红包、宝箱任务"
        checked={on || asking} disabled={asking}
        onChange={(checked) => { if (checked) setAsking(true); else session.updateSettings({ douyuWrites: false }) }} />
      {asking && (
        <div className="writes-confirm" role="group" aria-label="确认打开斗鱼写操作">
          <p className="note-warn">这些操作会用你的斗鱼账号真实执行，可能触发平台风控或账号限制。它们尚未逐项验收，出现异常请立即关闭。</p>
          <span className="row-end">
            <button type="button" className="btn-quiet small" onClick={() => setAsking(false)}>取消</button>
            <button type="button" className="btn-solid small" onClick={() => { session.updateSettings({ douyuWrites: true }); setAsking(false) }}>确认打开</button>
          </span>
        </div>
      )}
      {on && <p className="muted">关闭后入口会隐藏，已在运行的任务不会停止，请先在批量任务和房间任务里暂停。</p>}
    </div>
  )
}
