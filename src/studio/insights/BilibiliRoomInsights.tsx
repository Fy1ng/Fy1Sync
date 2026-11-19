import type { BilibiliRoomSnapshot, BilibiliWatchEvidenceStatus } from '../../../server/platforms/bilibiliRoomInsights'
import '../bilibili.css'

export function BilibiliRoomInsights({ room, data, watch, error, onOpenOfficialRoom }: {
  room: string
  data?: BilibiliRoomSnapshot | null
  watch?: BilibiliWatchEvidenceStatus | null
  error?: string
  onOpenOfficialRoom?: () => void
}): React.ReactNode {
  const snapshot = data?.room === room ? data : null
  const evidence = watch && `bilibili:${watch.room}` === room ? watch : null
  const metrics = snapshot ? [
    ['弹幕记录', snapshot.messages],
    ['已知发言用户', snapshot.users],
    ['近一分钟弹幕', snapshot.rate.receivedLastMinute],
    ['醒目留言条数', snapshot.superChats],
    ['醒目留言金额（元）', snapshot.superChatYuan],
    ['人气值', snapshot.metrics.popularity?.count ?? '未收到'],
    ['全房观看计数', snapshot.metrics.watched?.count ?? '未收到'],
    ['全房点赞计数', snapshot.metrics.likes?.count ?? '未收到'],
  ] as const : []
  const reason = evidence?.reason === 'login-required' ? '请登录哔哩哔哩后在官方房间核对粉丝团页面'
    : evidence?.reason === 'session-unconfirmed' ? '当前直播场次待确认'
    : '请在官方直播间核对'
  return <div className="settings-page">
    <h3>哔哩哔哩房间 {room.replace(/^bilibili:/, '')}</h3>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!snapshot && !error && <p>尚未读取房间数据</p>}
    {snapshot && <p className="muted">弹幕和醒目留言仅统计最近 {snapshot.capacity} 条记录，全房计数由平台提供</p>}
    <dl className="bili-insights-grid">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {snapshot && <p className="muted">更新于 {new Date(snapshot.checkedAt).toLocaleString('zh-CN')}</p>}
    {snapshot?.truncated && <p className="muted">记录已满，较早数据已移除</p>}
    <h4>个人看播</h4>
    <p className="muted">本房今日观看时长、累计观看时长和个人看播任务均未知，{reason}</p>
    {onOpenOfficialRoom && <button type="button" onClick={onOpenOfficialRoom}>打开官方直播间</button>}
  </div>
}
