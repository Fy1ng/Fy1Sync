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
import type { DouyuInsightsEvent, DouyuRankEntry, DouyuRoomInsights, DouyuWatchTime, DouyuFansWatchTime } from '../../../server/douyu/insightsTypes'
import type { DouyuWatchState } from '../../../server/douyu/watchTypes'
import { Icon, Segmented, Sheet, SideTabs } from '../kit'
import { formatCount, formatDuration, formatMinor, formatTime, UNKNOWN } from './format'
import './insights.css'
import { useRemembered } from '../../app/remembered'
import { useDouyuPlaybackReports } from './douyuPlayback'

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

const WATCH_PHASES = new Set(['idle', 'login-required', 'paused', 'connecting', 'reporting', 'yielding', 'unverified', 'verified', 'failed'])
const validWatchState = (value: unknown): value is DouyuWatchState => !!value && typeof value === 'object'
  && WATCH_PHASES.has((value as DouyuWatchState).phase)
  && ((value as DouyuWatchState).room === null || typeof (value as DouyuWatchState).room === 'string')
  && Number.isSafeInteger((value as DouyuWatchState).verifiedIncrease) && (value as DouyuWatchState).verifiedIncrease >= 0

/** A pushed snapshot wins over an initial read that was already in flight. */
function useWatchState(): DouyuWatchState | null {
  const [state, setState] = useState<DouyuWatchState | null>(null)
  useEffect(() => {
    let live = true, pushed = false
    const unsubscribe = apiClient.subscribeFeatures(event => {
      if (event.topic !== 'douyu-watch' || !validWatchState(event.data)) return
      pushed = true
      if (live) setState(event.data)
    })
    void apiClient.feature('getDouyuWatchState', undefined).then(result => {
      if (live && !pushed && result.ok && validWatchState(result.value)) setState(result.value)
    }).catch(() => {})
    return () => { live = false; unsubscribe() }
  }, [])
  return state
}

function liveState(insights: DouyuRoomInsights): string {
  if (insights.replay === true) return '轮播中'
  if (insights.live === true && insights.replay === false) return '直播中'
  if (insights.live === false) return '未开播'
  return '直播或轮播状态未确认'
}

export function RoomInsightsSheet({ room, onClose }: { room: string; onClose: () => void }): React.ReactNode {
  return <Sheet title="房间数据" onClose={onClose}><RoomInsights room={room} /></Sheet>
}

/** The 房间数据 section of 设置: statistics for the connected danmaku room. */
export function RoomInsights({ room }: { room: string }): React.ReactNode {
  // Per room: reopening shows the last figures at once; the reads below bring them up to date.
  const [tab, setTab] = useRemembered<Tab>('insights:tab', 'overview')
  const [insights, setInsights] = useRemembered<DouyuRoomInsights | null>(`insights:${room}`, null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [watch, setWatch] = useRemembered<Watch>(`insights:watch:${room}`, { kind: 'loading' })
  const [fansWatch, setFansWatch] = useState<DouyuFansWatchTime | null>(null)
  const watchState = useWatchState()
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
    let remotePending = false
    setError('')
    setFansWatch(null)
    // A busy room changes many times a second; one read at a time, plus one trailing read.
    const read = (remote = false): void => {
      if (!live) return
      remotePending ||= remote
      if (reading) { dirty = true; return }
      reading = true
      dirty = false
      const method = remotePending ? 'refreshDouyuRoomInsights' : 'getDouyuRoomInsights'
      remotePending = false
      const mine = ++sequence.current
      void apiClient.feature(method, { room }).then((result) => {
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
    read(true)
    const timer = setInterval(() => read(true), 60_000)
    void readWatch(room)
    return () => { live = false; alive.current = false; clearInterval(timer); unsubscribe() }
  }, [room])

  const current = (target: string): boolean => alive.current && roomRef.current === target

  async function readWatch(target: string): Promise<void> {
    // A remembered figure stays up while it is read again; only a first read shows 正在读取.
    setWatch((previous) => previous.kind === 'value' ? previous : { kind: 'loading' })
    const accounts = await apiClient.listDouyuAccounts()
    if (!current(target)) return
    if (!accounts.ok) { setWatch({ kind: 'missing', reason: accounts.message }); return }
    const active = accounts.value.accounts.find((account) => account.id === accounts.value.activeAccountId)
    if (!active) { setWatch({ kind: 'missing', reason: '未设置当前账号' }); return }
    if (!active.login.loggedIn) { setWatch({ kind: 'missing', reason: '当前账号未登录' }); return }
    const [daily, cumulative] = await Promise.allSettled([
      apiClient.feature('getDouyuWatchTime', { accountId: active.id, room: target, refresh: true }),
      apiClient.feature('getDouyuFansWatchTime', { accountId: active.id, room: target, refresh: true }),
    ])
    if (!current(target)) return
    if (cumulative.status === 'fulfilled' && cumulative.value.ok && cumulative.value.value.accountId === active.id && cumulative.value.value.room === target) setFansWatch(cumulative.value.value)
    else setFansWatch(null)
    if (daily.status !== 'fulfilled') { setWatch({ kind: 'missing', reason: '官方今日观看查询失败' }); return }
    const result = daily.value
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
        {insights && tab === 'overview' && <Overview insights={insights} watch={watch} watchState={watchState} fansWatch={fansWatch} />}
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

function Overview({ insights, watch, watchState, fansWatch }: { insights: DouyuRoomInsights; watch: Watch; watchState: DouyuWatchState | null; fansWatch: DouyuFansWatchTime | null }): React.ReactNode {
  const { coverage, gifts, nobles } = insights
  const live = insights.live === true && insights.replay === false
  const unknownGifts = gifts.unknownValueCount > 0
  const giftValue = gifts.totalValueMinor !== null ? `${formatMinor(gifts.totalValueMinor)} 鱼翅` : UNKNOWN
  const updated = `更新于 ${formatTime(insights.checkedAt)}`
  let officialWatch = watch
  if (watchState?.phase === 'login-required' || (watchState && !watchState.accountId)) {
    officialWatch = { kind: 'missing', reason: '当前账号未登录或未设置' }
  } else if (watchState?.room === insights.room && watchState.accountId && watchState.officialSeconds !== null && watchState.checkedAt !== null) {
    officialWatch = { kind: 'value', value: { accountId: watchState.accountId, room: insights.room,
      seconds: watchState.officialSeconds, checkedAt: watchState.checkedAt, source: 'douyu-today-watch' } }
  } else if (watchState && watch.kind === 'value' && watch.value.accountId !== watchState.accountId) {
    officialWatch = { kind: 'missing', reason: '当前账号官方观看时长尚未读取' }
  }

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
          <WatchStat watch={officialWatch} />
          <FansWatchStat state={watchState} value={fansWatch} room={insights.room} />
          <WatchSessionStat state={watchState} room={insights.room} />
        </dl>
        <p className="lane">本地观看时长只记录本应用中的实际播放，不计入斗鱼官方观看时长。</p>
      </section>
    </>
  )
}

function WatchSessionStat({ state, room }: { state: DouyuWatchState | null; room: string }): React.ReactNode {
  const active = state?.room === room ? state : null
  const labels: Record<DouyuWatchState['phase'], string> = {
    idle: '尚未启动', 'login-required': '需要登录', paused: '已暂停', connecting: '正在连接', reporting: '正在上报',
    yielding: '等待账号操作完成', unverified: '累计观时未确认增长', verified: '粉丝牌累计观时已增长', failed: '上报失败',
  }
  const verified = active && active.cumulativeIncrease > 0 && active.badgeOwned === true
  const phase = active?.phase === 'verified' && !verified ? 'unverified' : active?.phase
  const note = verified ? `本次粉丝牌累计观看增加 ${formatDuration(active.cumulativeIncrease)}. ${active.reason ?? ''}`
    : active?.reason ?? '登录持有此房间粉丝牌的账号并实际播放后验证. 今日观看增长不能代替累计观时验收.'
  return <Stat label="官方观时上报" value={phase ? labels[phase] : '尚未启动'} note={note} />
}

function FansWatchStat({ state, value, room }: { state: DouyuWatchState | null; value: DouyuFansWatchTime | null; room: string }): React.ReactNode {
  const active = state?.room === room && state.phase !== 'login-required' ? state : null
  const accountValid = state?.phase !== 'login-required' && value?.room === room && (!state || value.accountId === state.accountId)
  const seconds = active?.cumulativeCheckedAt !== null && active?.cumulativeCheckedAt !== undefined
    ? active.cumulativeSeconds : accountValid ? value!.seconds : null
  const owned = active?.cumulativeCheckedAt !== null && active?.cumulativeCheckedAt !== undefined
    ? active.badgeOwned : accountValid ? value!.badgeOwned : null
  const level = active?.cumulativeCheckedAt !== null && active?.cumulativeCheckedAt !== undefined
    ? active.badgeLevel : accountValid ? value!.badgeLevel : null
  const badge = owned === true ? `已持有${level === null ? '' : ` ${level} 级`}粉丝牌.` : owned === false ? '当前账号未持有此房间粉丝牌.' : '粉丝牌持有状态未确认.'
  const baseline = active?.cumulativeBaselineSeconds === null || active?.cumulativeBaselineSeconds === undefined ? ''
    : ` 本次基线 ${formatDuration(active.cumulativeBaselineSeconds)}, 增加 ${formatDuration(active.cumulativeIncrease)}.`
  return <Stat label="粉丝牌累计观看" value={formatDuration(seconds)} note={`${badge}${baseline} 来源: 斗鱼粉丝家园累计观看.`} />
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

/** One Studio mount reports local time and account-owned viewing from the actual video. */
export function usePlaybackHeartbeat(): void {
  useDouyuPlaybackReports()
}
