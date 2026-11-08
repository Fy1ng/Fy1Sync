import { useEffect, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { FeatureMethods } from '../../../electron/featureContracts'
import '../bilibili.css'

type Snapshot = FeatureMethods['getBilibiliRoomInsights']['result']
export function BilibiliRoomInsights({ room }: { room: string }): React.ReactNode {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setData(null); setError('')
    const load = async () => {
      const result = await apiClient.feature('getBilibiliRoomInsights', { room })
      if (!active) return
      if (result.ok) { setData(result.value); setError('') } else setError(result.message)
    }
    void load(); const timer = setInterval(() => void load(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [room])
  const metrics = data ? [
    ['弹幕记录', data.messages], ['已知发言用户', data.users], ['近一分钟弹幕', data.rate.receivedLastMinute],
    ['SC 条数', data.superChats], ['SC 金额（元）', data.superChatYuan], ['人气值', data.popularity ?? '未收到'],
    ['累计观看（平台推送）', data.watched ?? '未收到'], ['点赞（平台推送）', data.likes ?? '未收到'],
  ] : []
  return <div className="settings-page">
    <h3>B 站房间 {room.slice('bilibili:'.length)}</h3>
    <p className="muted">弹幕和 SC 统计基于本应用运行期间收到且仍保留的记录，最多 {data?.capacity ?? 10000} 条；重启后重置。发言用户仅统计平台提供了 UID 的用户。</p>
    <p className="muted">人气值不等于在线人数。观看和点赞显示平台最近一次推送，未收到时不填零。</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!data && !error && <p>正在读取房间数据…</p>}
    <dl className="bili-insights-grid">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {data?.truncated && <p className="muted">记录容量已满，较早数据已移除。</p>}
  </div>
}
