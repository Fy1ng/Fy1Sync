import { useEffect, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { useSessionSnapshot } from '../../app/SessionContext'
import { buildYouTubeWatchEvidence } from '../../core/youtubeWatchEvidence'
import { createTwitchProgressSnapshot } from '../../core/twitchProgress'
import { SOURCE_ROLES, type SourceRole } from '../../core/types'
import type { BilibiliEmoteCatalog } from '../../../server/platforms/bilibiliEmotes'
import type { BilibiliRoomSnapshot, BilibiliWatchEvidenceStatus } from '../../../server/platforms/bilibiliRoomInsights'
import { BilibiliMessage } from '../BilibiliMessage'
import { HuyaRoomWatchStatus } from '../HuyaOnTvCard'
import { BilibiliRoomInsights } from './BilibiliRoomInsights'

export function BilibiliEmoteDirectory({ room }: { room: string }) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<BilibiliEmoteCatalog | null>(null)
  const [problem, setProblem] = useState('')
  const [generation, setGeneration] = useState(0)
  useEffect(() => apiClient.subscribeFeatures(event => {
    if (event.topic === 'bilibili-lottery-invalidated') {
      setCatalog(null)
      setGeneration(previous => previous + 1)
    }
  }), [])
  useEffect(() => {
    if (!open) return
    let active = true
    setCatalog(null)
    setProblem('')
    void apiClient.feature('getBilibiliEmoteCatalog', { room }).then(result => {
      if (!active) return
      if (result.ok && `bilibili:${result.value.room}` === room) setCatalog(result.value)
      else setProblem(!result.ok && result.code === 'login-required' ? '请先登录 B 站.' : 'B 站表情目录暂不可用.')
    })
    return () => { active = false }
  }, [room, open, generation])
  return <details className="bilibili-lottery-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>B 站表情目录</summary>
    <div className="bilibili-lottery-content">
      {catalog ? <>
        <p>发送资格需在官方房间核对.</p>
        {catalog.packages.length === 0 && <p>官方未返回表情包.</p>}
        {catalog.packages.map((group, index) => <details key={`${group.name}:${index}`}>
          <summary>{group.name}</summary>
          <ul>{group.emotes.map((emote, index) => <li key={`${emote.id ?? emote.text}:${index}`}>
            <BilibiliMessage text={emote.text} emotes={[{ text: emote.text, url: emote.url }]} />
            {emote.requiredMedalLevel !== undefined && ` 粉丝勋章条件 ${emote.requiredMedalLevel} 级`}
          </li>)}</ul>
        </details>)}
      </> : <p role="status">{problem || '正在读取表情目录.'}</p>}
    </div>
  </details>
}

function BilibiliInsights({ room }: { room: string }) {
  const [data, setData] = useState<BilibiliRoomSnapshot | null>(null)
  const [watch, setWatch] = useState<BilibiliWatchEvidenceStatus | null>(null)
  const [problem, setProblem] = useState<string>()
  const [openProblem, setOpenProblem] = useState<string>()
  const [generation, setGeneration] = useState(0)
  useEffect(() => apiClient.subscribeFeatures(event => {
    if (event.topic === 'bilibili-lottery-invalidated') {
      setWatch(null)
      setGeneration(previous => previous + 1)
    }
  }), [])
  useEffect(() => {
    let active = true
    const read = () => void apiClient.feature('getBilibiliRoomInsights', { room }).then(result => {
      if (!active) return
      if (result.ok) { setData(result.value); setProblem(undefined) }
      else setProblem('B 站房间统计暂不可用.')
    })
    read()
    const timer = setInterval(read, 5_000)
    return () => { active = false; clearInterval(timer) }
  }, [room])
  useEffect(() => {
    let active = true
    void apiClient.feature('getBilibiliWatchEvidence', { room }).then(result => {
      if (active && result.ok) setWatch(result.value)
    })
    return () => { active = false }
  }, [room, generation])
  return <BilibiliRoomInsights room={room} data={data} watch={watch} error={openProblem ?? problem} onOpenOfficialRoom={() => {
    setOpenProblem(undefined)
    void apiClient.feature('openBilibiliRoomInfo', { room }).then(result => {
      if (!result.ok || !result.value.opened) setOpenProblem('暂时无法打开该 B 站房间.')
    })
  }} />
}

export function RestrictedChatStatus({ role }: { role: SourceRole }) {
  const source = useSessionSnapshot().media[role].descriptor
  const label = role === 'official' ? '画面' : '解说'
  if (source?.platform === 'youtube') return <p className="settings-empty" role="status">{label} YouTube 聊天不可用. 此应用没有已授权的 YouTube Data API 聊天读取凭据.</p>
  if (source?.platform === 'twitch') return <p className="settings-empty" role="status">{label} Twitch 聊天不可用. 当前没有获准的 Twitch 账户聊天读取授权.</p>
  return null
}

function RestrictedRoomEvidence({ role }: { role: SourceRole }) {
  const source = useSessionSnapshot().media[role].descriptor
  const [problem, setProblem] = useState(false)
  const open = async (entry: 'history' | 'time-watched' | 'channel' | 'drops') => {
    const result = await apiClient.feature('openPlatformRoomInfo', { role, entry })
    setProblem(!result.ok || !result.value.opened)
  }
  if (source?.platform === 'youtube') {
    const state = buildYouTubeWatchEvidence({ accountRef: null, authorized: false, videoId: source.sourceChannel ?? null, channelId: source.sourceRoom })
    return <section className="settings-page">
      <h3>YouTube {state.videoId ? `视频 ${state.videoId}` : '当前视频待确认'}</h3>
      <p>{state.history.message}</p><p>当前账号本场今日和累计观看时长未知. {state.personalSessionTime.message}</p>
      <p>{state.timeWatched.message}</p><p>{state.creatorAnalytics.message}</p>
      <button type="button" onClick={() => void open('history')}>打开官方观看历史</button>
      {problem && <p role="status">暂时无法打开官方查看入口.</p>}
    </section>
  }
  if (source?.platform === 'twitch') {
    const state = createTwitchProgressSnapshot({ channelLogin: source.sourceChannel })
    return <section className="settings-page">
      <h3>Twitch {state.channelLogin ?? '频道待确认'}</h3>
      <dl>
        {([
          ['本频道今日及累计观看', state.watchMinutes], ['频道积分', state.channelPoints],
          ['连续观看', state.watchStreak], ['Drops 进度', state.dropsProgress], ['Drops 权益', state.dropEntitlements],
        ] as const).map(([label, metric]) => <div key={label}><dt>{label}</dt><dd>未核验. {metric.detail}</dd></div>)}
      </dl>
      {state.officialLinks.channel && <button type="button" onClick={() => void open('channel')}>打开 Twitch 频道</button>}
      <button type="button" onClick={() => void open('drops')}>打开 Twitch Drops 库存</button>
      {problem && <p role="status">暂时无法打开官方查看入口.</p>}
    </section>
  }
  return null
}

export function PlatformRoomInsights({ room }: { room: string | null }) {
  const snapshot = useSessionSnapshot()
  const sources = SOURCE_ROLES.filter(role => snapshot.media[role].status === 'ready'
    && ['youtube', 'twitch'].includes(snapshot.media[role].descriptor?.platform ?? ''))
  return <>
    {room?.startsWith('bilibili:') && <BilibiliInsights key={room} room={room} />}
    {room?.startsWith('huya:') && <HuyaRoomWatchStatus room={room} />}
    {room?.startsWith('douyin:') && <section className="settings-page">
      <h3>抖音直播间 {room.slice(7)}</h3>
      <p>本房官方今日和累计观看时长未知. 当前没有可核验的同账号同场次读回.</p>
      <p>个人看播任务请在官方直播间的直播粉丝团或购物粉丝团面板分别查看. 普通福袋开奖时间是活动信息.</p>
    </section>}
    {sources.map(role => <RestrictedRoomEvidence key={`${role}:${snapshot.media[role].descriptor?.url}`} role={role} />)}
    {!room && sources.length === 0 && <p className="settings-empty">连接直播间后显示房间数据</p>}
  </>
}
