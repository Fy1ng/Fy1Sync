/**
 * Room statistics (handoff items 68, 70, 71, 72) and the local watch-time heartbeat.
 *
 * Everything here is what this app actually received from the room's anonymous stream,
 * since it started listening. It is not the room's history, and the sheet says so: the
 * coverage window comes first, values the platform did not give stay 未知, and nothing is
 * derived from a stand-in (heat is not viewers, a contribution score is not money).
 */

import { useEffect, useRef, useState } from 'react'
import { apiClient, type ApiResult } from '../../app/apiClient'
import { useSessionSnapshot } from '../../app/SessionContext'
import type { SessionSnapshot } from '../../app/session'
import type { DouyuInsightsEvent, DouyuRankEntry, DouyuRoomInsights, DouyuWatchTime } from '../../../server/douyu/insightsTypes'
import { Icon, Segmented, Sheet, SideTabs } from '../kit'
import { formatCount, formatDuration, formatMinor, formatTime, UNKNOWN } from './format'
import './insights.css'

type Tab = 'overview' | 'ranks'
type RankKey = 'day' | 'week' | 'all'
const RANKS: { value: RankKey; label: string }[] = [
  { value: 'day', label: '日榜' },
  { value: 'week', label: '周榜' },
  { value: 'all', label: '总榜' },
]

/** Official watch time needs a signed-in current account; each reason it is missing is said. */
type Watch =
  | { kind: 'loading' }
  | { kind: 'value'; value: DouyuWatchTime }
  | { kind: 'missing'; reason: string }

const isInsightsEvent = (value: unknown): value is DouyuInsightsEvent =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'

const validInsights = (value: unknown, room: string): value is DouyuRoomInsights =>
  !!value && typeof value === 'object' && (value as DouyuRoomInsights).room === room
  && typeof (value as DouyuRoomInsights).coverage === 'object'

function liveState(insights: DouyuRoomInsights): string {
  if (insights.replay === true) return '回放'
  if (insights.live === true) return '直播中'
  if (insights.live === false) return '未开播'
  return '开播状态未知'
}

export function RoomInsightsSheet({ room, onClose }: { room: string; onClose: () => void }): React.ReactNode {
  return <Sheet title="房间数据" onClose={onClose}><RoomInsights room={room} /></Sheet>
}

/** The 房间数据 section of 设置: statistics for the connected danmaku room. */
export function RoomInsights({ room }: { room: string }): React.ReactNode {
  const [tab, setTab] = useState<Tab>('overview')
  const [insights, setInsights] = useState<DouyuRoomInsights | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [watch, setWatch] = useState<Watch>({ kind: 'loading' })
  const sequence = useRef(0)
  const applied = useRef(0)
  const alive = useRef(true)
  const roomRef = useRef(room)
  roomRef.current = room

  /** Apply a snapshot only for the room still shown, and only if nothing later has landed. */
  const accept = (target: string, mine: number, result: ApiResult<DouyuRoomInsights>): void => {
    if (!alive.current || target !== roomRef.current || mine < applied.current) return
    applied.current = mine
    if (!result.ok) { setError(result.message); return }
    if (!validInsights(result.value, target)) { setError('无法读取房间数据'); return }
    setError('')
    setInsights(result.value)
  }

  useEffect(() => {
    alive.current = true
    let live = true
    let reading = false
    let dirty = false
    setInsights(null)
    setError('')
    // A busy room changes many times a second; one read at a time, plus one trailing read.
    const read = (): void => {
      if (!live) return
      if (reading) { dirty = true; return }
      reading = true
      dirty = false
      const mine = ++sequence.current
      void apiClient.feature('getDouyuRoomInsights', { room }).then((result) => {
        if (live) accept(room, mine, result)
      }).finally(() => {
        reading = false
        if (live && dirty) read()
      })
    }
    // Subscribe before the first read so a change between the two is not lost.
    const unsubscribe = apiClient.subscribeFeatures((event) => {
      if (event.topic !== 'insights' || !isInsightsEvent(event.data)) return
      if (event.data.type === 'changed' && event.data.room === room) read()
    })
    read()
    void readWatch(room)
    return () => { live = false; alive.current = false; unsubscribe() }
  }, [room])

  const current = (target: string): boolean => alive.current && roomRef.current === target

  async function readWatch(target: string): Promise<void> {
    setWatch({ kind: 'loading' })
    const accounts = await apiClient.listDouyuAccounts()
    if (!current(target)) return
    if (!accounts.ok) { setWatch({ kind: 'missing', reason: accounts.message }); return }
    const active = accounts.value.accounts.find((account) => account.id === accounts.value.activeAccountId)
    if (!active) { setWatch({ kind: 'missing', reason: '未设置当前账号' }); return }
    if (!active.login.loggedIn) { setWatch({ kind: 'missing', reason: '当前账号未登录' }); return }
    const result = await apiClient.feature('getDouyuWatchTime', { accountId: active.id, room: target })
    if (!current(target)) return
    if (!result.ok) setWatch({ kind: 'missing', reason: result.message })
    else if (result.value.room !== target) setWatch({ kind: 'missing', reason: '无法读取官方观看时长' })
    else setWatch({ kind: 'value', value: result.value })
  }

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    const mine = ++sequence.current
    void Promise.all([
      apiClient.feature('refreshDouyuRoomInsights', { room }).then((result) => accept(room, mine, result)),
      readWatch(room),
    ]).finally(() => { if (alive.current) setRefreshing(false) })
  }

  return (
    <SideTabs label="房间数据" value={tab} onChange={setTab}
      tabs={[{ id: 'overview', label: '概况' }, { id: 'ranks', label: '榜单' }]}
      aside={<>
        <span className="insights-room muted">房间 <span className="num">{room}</span></span>
        <button type="button" className="btn-quiet small" disabled={refreshing} onClick={refresh}>
          <Icon name="refresh" />{refreshing ? '正在刷新' : '刷新'}
        </button>
      </>}>
      <div className="insights-body">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!insights && !error && <p className="lane" role="status">正在读取房间数据</p>}
        {insights && tab === 'overview' && <Overview insights={insights} watch={watch} />}
        {insights && tab === 'ranks' && <Ranks insights={insights} />}
      </div>
    </SideTabs>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: React.ReactNode }): React.ReactNode {
  return (
    <div className="stat" role="group" aria-label={label}>
      <dt>{label}</dt>
      <dd>
        <span className={value === UNKNOWN ? 'stat-unknown' : 'num'}>{value}</span>
        {note && <small>{note}</small>}
      </dd>
    </div>
  )
}

function Overview({ insights, watch }: { insights: DouyuRoomInsights; watch: Watch }): React.ReactNode {
  const { coverage, gifts, nobles } = insights
  const live = insights.live === true && insights.replay !== true
  const unknownGifts = gifts.unknownValueCount > 0
  const giftValue = gifts.totalValueMinor !== null ? `${formatMinor(gifts.totalValueMinor)} 鱼翅` : UNKNOWN
  const updated = `更新于 ${formatTime(insights.checkedAt)}`

  return (
    <>
      <section className="insights-section" aria-label="统计范围">
        <h3>统计范围</h3>
        <p className="lane">
          仅包含本应用自 {formatTime(insights.observedSince)} 起接收到的匿名消息，不是房间的完整历史。
          {insights.connected ? '' : '弹幕连接当前未建立。'}
        </p>
        <dl className="stat-grid">
          <Stat label="统计起点" value={formatTime(insights.observedSince)} />
          <Stat label="连接中断" value={coverage.disconnected ? '有' : '无'} note={coverage.disconnected ? '中断期间的数据无法补齐' : undefined} />
          <Stat label="丢弃事件" value={formatCount(coverage.droppedEvents)} />
          <Stat label="发送者未知的事件" value={formatCount(coverage.unknownSenderEvents)} />
        </dl>
        {coverage.uniqueUsersTruncated && <p className="insights-warn">独立用户数量已达统计上限，人数为下限值。</p>}
      </section>

      <section className="insights-section" aria-label="观众与互动">
        <h3>观众与互动</h3>
        <dl className="stat-grid">
          <Stat label="观众人数" value={UNKNOWN} note="平台未提供可核验的观众人数，热度不计为观众" />
          <Stat label="独立发言人数" value={`${coverage.uniqueUsersTruncated ? '≥ ' : ''}${formatCount(insights.uniqueChatters)}`} />
          <Stat label="独立赠礼人数" value={`${coverage.uniqueUsersTruncated ? '≥ ' : ''}${formatCount(insights.uniqueGiftSenders)}`} />
          <Stat label="贵宾人数" value={nobles ? formatCount(nobles.count) : UNKNOWN}
            note={nobles ? `官方快照，接收于 ${formatTime(nobles.receivedAt)}` : '未收到官方贵宾快照'} />
        </dl>
      </section>

      <section className="insights-section" aria-label="礼物">
        <h3>礼物</h3>
        <dl className="stat-grid">
          <Stat label="礼物数" value={formatCount(gifts.count)} />
          <Stat label="目录标称价值" value={giftValue}
            note={unknownGifts
              ? `已知部分 ${formatMinor(gifts.knownValueMinor)} 鱼翅，${formatCount(gifts.unknownValueCount)} 件价格未知`
              : undefined} />
        </dl>
        <p className="lane">按该房间官方礼物目录的鱼翅标称价格计算，不代表主播收入或观众实际支付金额。</p>
      </section>

      <section className="insights-section" aria-label="时长">
        <h3>时长</h3>
        <dl className="stat-grid">
          <Stat label="开播状态" value={liveState(insights)} note={updated} />
          <Stat label="已播时长" value={live ? formatDuration(insights.broadcastSeconds) : UNKNOWN}
            note={live ? `来源：斗鱼房间信息 · ${updated}` : '仅在直播中且开播时间可核验时显示'} />
          <Stat label="本次开播" value={live ? formatTime(insights.startedAt) : UNKNOWN} note="来源：斗鱼房间信息" />
          <Stat label="上次开播" value={formatTime(insights.lastStartedAt)} note="来源：斗鱼房间信息" />
        </dl>
        <dl className="stat-grid">
          <Stat label="本地观看时长" value={formatDuration(insights.localWatchSeconds)}
            note={`来源：本应用实际播放记录 · ${updated}`} />
          <WatchStat watch={watch} />
        </dl>
        <p className="lane">本地观看时长只记录本应用中的实际播放，不计入斗鱼官方观看时长。</p>
      </section>
    </>
  )
}

function WatchStat({ watch }: { watch: Watch }): React.ReactNode {
  if (watch.kind === 'loading') return <Stat label="官方今日观看" value={UNKNOWN} note="正在读取" />
  if (watch.kind === 'missing') return <Stat label="官方今日观看" value={UNKNOWN} note={watch.reason} />
  const { seconds, checkedAt } = watch.value
  return (
    <Stat label="官方今日观看" value={formatDuration(seconds)}
      note={`来源：斗鱼今日观看 · 更新于 ${formatTime(checkedAt)}${seconds === null ? ' · 平台未返回' : ''}`} />
  )
}

/** Platform contribution score: gold / 100, never a currency amount. */
function contributionOf(entry: DouyuRankEntry): string {
  const value = entry.contribution ?? (entry.gold !== null ? entry.gold / 100 : null)
  if (value === null || !Number.isFinite(value)) return UNKNOWN
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function Ranks({ insights }: { insights: DouyuRoomInsights }): React.ReactNode {
  const [which, setWhich] = useState<RankKey>('day')
  const ranks = insights.ranks
  const list = ranks ? ranks[which] : null
  return (
    <section className="insights-section" aria-label="榜单">
      <div className="row-split">
        <Segmented label="榜单" value={which} options={RANKS} onChange={setWhich} />
        <span className="muted">{ranks ? `接收于 ${formatTime(ranks.receivedAt)}` : '未收到榜单'}</span>
      </div>
      <p className="lane">贡献值为平台榜单展示值（gold ÷ 100），不是金额。</p>
      {!ranks && <p className="desk-empty">尚未收到该房间的榜单信号。</p>}
      {ranks && list === null && <p className="desk-empty">未收到{RANKS.find((item) => item.value === which)!.label}。</p>}
      {list && list.length === 0 && <p className="desk-empty">榜单为空。</p>}
      {list && list.length > 0 && (
        <table className="rank-table">
          <thead>
            <tr><th scope="col">排名</th><th scope="col">用户</th><th scope="col">贡献值</th></tr>
          </thead>
          <tbody>
            {list.map((entry, index) => (
              <tr key={`${entry.uid ?? 'anon'}-${index}`}>
                <td className="num">{index + 1}</td>
                <td>{entry.nickname || UNKNOWN}</td>
                <td className={contributionOf(entry) === UNKNOWN ? 'stat-unknown' : 'num'}>{contributionOf(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Messages per minute for the chat header; null while unknown. */
export function useDanmakuRate(room: string | null): number | null {
  const [rate, setRate] = useState<{ room: string; value: number | null } | null>(null)
  useEffect(() => {
    if (!room || !/^[1-9]\d{0,11}$/.test(room)) return
    let live = true
    const read = (): void => {
      void apiClient.feature('getDanmakuRate', { room }).then((result) => {
        if (!live) return
        // `since: null` means nothing was received yet: unknown, not zero.
        const value = result.ok && result.value.room === room && result.value.since !== null
          && Number.isFinite(result.value.messagesPerMinute) ? result.value.messagesPerMinute : null
        setRate({ room, value })
      })
    }
    read()
    const timer = setInterval(read, 10_000)
    return () => { live = false; clearInterval(timer) }
  }, [room])
  // A value read for the previous room never shows under the new one.
  return room && rate?.room === room ? rate.value : null
}

/** Whether any loaded source in this window is actually playing. */
export function isPlaying(media: SessionSnapshot['media']): boolean {
  return Object.values(media).some((state) => state.status === 'ready' && !state.paused)
}

const HEARTBEAT_MS = 5_000

/**
 * Reports real playback of the main window's Douyu room for local watch time. Mounted once
 * by Studio. Sends only the playing flag — the main process does the counting — every 5 s
 * while playing, on every play/pause change, and false before leaving a room or the page.
 */
export function usePlaybackHeartbeat(): void {
  const snapshot = useSessionSnapshot()
  const selected = snapshot.danmaku.room
  const room = selected && /^[1-9]\d{0,11}$/.test(selected) ? selected : null
  const playing = isPlaying(snapshot.media)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const sent = useRef<{ room: string; playing: boolean } | null>(null)

  const report = (target: string, value: boolean): void => {
    sent.current = { room: target, playing: value }
    try {
      void apiClient.feature('reportDouyuPlayback', { room: target, playing: value }).catch(() => {})
    } catch { /* A missing bridge only loses local statistics. */ }
  }

  useEffect(() => {
    if (!room) return
    report(room, playingRef.current)
    const timer = setInterval(() => { if (playingRef.current) report(room, true) }, HEARTBEAT_MS)
    const leave = (): void => report(room, false)
    window.addEventListener('pagehide', leave)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', leave)
      report(room, false)
      sent.current = null
    }
  }, [room])

  useEffect(() => {
    if (!room) return
    if (sent.current?.room === room && sent.current.playing === playing) return
    report(room, playing)
  }, [room, playing])
}
