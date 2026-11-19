import type { SourceRole } from '../core/types'
import type { BilibiliLotteryHookOptions } from '../core/bilibiliLotteryHook'
import { useBilibiliLottery } from '../core/bilibiliLotteryHook'
import { bilibiliLotteryConditions, type BilibiliLotterySnapshot } from '../core/bilibiliLottery'
import './bilibiliLottery.css'

const PHASE_TEXT: Record<BilibiliLotterySnapshot['phase'], string> = {
  empty: '当前没有天选福袋', ongoing: '正在进行', settling: '正在开奖', ended: '本轮已结束', unverified: '活动信息待官方确认',
  'login-required': '登录已失效或需要登录', restricted: '平台限制了活动读取, 请前往官网', unavailable: '暂时无法读取活动',
}

export interface BilibiliLotterySource {
  slot: SourceRole
  input: string
  platform: string
  active: boolean
  loading?: boolean
  reconnectKey?: string
}

export function BilibiliLotteryCards({ sources, client, onSnapshot, onReminder }:
  Pick<BilibiliLotteryHookOptions, 'client' | 'onSnapshot' | 'onReminder'> & { sources: readonly BilibiliLotterySource[] }) {
  return <div className="bilibili-lottery-cards">
    {sources.filter(source => source.platform === 'bilibili' && source.active && !source.loading).map(source =>
      <BilibiliLotteryCard key={`${source.slot}:${source.input}`} client={client} slot={source.slot}
        input={source.input} reconnectKey={source.reconnectKey} onSnapshot={onSnapshot} onReminder={onReminder} />)}
  </div>
}

export function BilibiliLotteryCard(options: BilibiliLotteryHookOptions) {
  const { snapshot, phase, remaining, problem, busy, reminders, setReminders, refresh, open, stale } = useBilibiliLottery(options)
  const seconds = remaining === null ? null : Math.ceil(remaining / 1000)
  const countdown = seconds === null ? '开奖时间待官方确认'
    : `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')} 后开奖`
  const activity = snapshot?.activity
  return <details className="bilibili-lottery-card">
    <summary>B站天选福袋 <span>{options.slot === 'official' ? '画面' : '解说'}</span>
      <strong>{phase === 'ongoing' ? countdown : phase ? PHASE_TEXT[phase] : problem || '读取中'}</strong></summary>
    <div className="bilibili-lottery-content">
      <p className="muted">{snapshot?.room ? `直播间 ${snapshot.room}` : '正在确认直播间'}{phase ? ` / ${PHASE_TEXT[phase]}` : ''}</p>
      {activity && <>
        <p className="bilibili-lottery-prize">{activity.prize}{activity.prizeCount === null ? '' : ` / ${activity.prizeCount} 份`}</p>
        <p>活动 ID: {activity.id}{stale ? ' / 上次读取, 当前状态待确认' : ''}</p>
        {phase === 'ongoing' && <p className="bilibili-lottery-countdown" aria-label="天选福袋开奖倒计时">{countdown}</p>}
        <ul>{bilibiliLotteryConditions(activity).map(condition => <li key={condition}>{condition}</li>)}</ul>
        {activity.messages.length > 0 && <div>官方候选口令:<ul>{activity.messages.map(command => <li key={command}><code className="bilibili-lottery-command">{command}</code></li>)}</ul></div>}
        <p className="muted">资格及参与结果待官方确认. 请到官网核对天选福袋入口. 同文弹幕只能作为线索, 不能证明自动发送或已经参与.</p>
      </>}
      <label className="bilibili-lottery-reminders"><input type="checkbox" checked={reminders}
        onChange={event => void setReminders(event.target.checked)} />提醒新天选福袋</label>
      <div className="bilibili-lottery-actions">
        <button type="button" className="btn-quiet small" disabled={busy} onClick={refresh}>{busy ? '读取中' : '刷新活动'}</button>
        <button type="button" className="btn-solid small" disabled={!snapshot?.room || stale}
          onClick={() => void open()}>打开官方直播间</button>
      </div>
      <p className="muted">倒计时按平台时钟, 不随视频延时. 礼物成本以官方确认为准, 浏览器可能需要单独登录.</p>
      {problem && <p role="alert" className="form-error">{problem}</p>}
    </div>
  </details>
}
