/**
 * Room statistics (handoff items 68, 70, 71, 72) and the local watch-time heartbeat.
 *
 * Everything here is what this app actually received from the room's anonymous stream,
 * since it started listening. It is not the room's history, and the sheet says so: the
 * coverage window comes first, values the platform did not give stay 未知, and nothing is
 * derived from a stand-in (heat is not viewers, a contribution score is not money).
 */

import { useEffect, useRef, useState } from 'react'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError, errorDetails, type DisplayError, type ErrorDetails } from '../../core/errorDetails'
import { apiClient, type ApiResult } from '../../app/apiClient'
import type { DouyuInsightsEvent, DouyuRankEntry, DouyuRoomInsights, DouyuWatchTime, DouyuFansWatchTime } from '../../../server/douyu/insightsTypes'
import { douyuWatchDay, type DouyuWatchRead, type DouyuWatchState } from '../../../server/douyu/watchTypes'
import type { DouyuAccountsSnapshot } from '../../../server/douyu/types'
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
  | { kind: 'value'; value: DouyuWatchTime; read?: DouyuWatchRead | null; baseline?: number | null }
  | { kind: 'missing'; reason: string; detail?: ErrorDetails; read?: DouyuWatchRead }

function accountScope(room: string, snapshot: DouyuAccountsSnapshot): string {
  const active = snapshot.accounts.find(account => account.id === snapshot.activeAccountId)
  return JSON.stringify([room, snapshot.revision, active?.id, active?.busy, active?.login.loggedIn])
}

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
function useWatchState(): { state: DouyuWatchState | null; error: DisplayError | null } {
  const [state, setState] = useState<DouyuWatchState | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  useEffect(() => {
    let live = true, pushed = false
    const unsubscribe = apiClient.subscribeFeatures(event => {
      if (event.topic !== 'douyu-watch' || !validWatchState(event.data)) return
      pushed = true
      if (live) { setState(event.data); setError(null) }
    })
    void apiClient.feature('getDouyuWatchState', undefined).then(result => {
      if (!live || pushed) return
      if (result.ok && validWatchState(result.value)) { setState(result.value); setError(null) }
      else setError(displayError(result, result.ok ? '无法读取官方观时上报状态' : undefined))
    }).catch(caught => { if (live && !pushed) setError(displayError(caught, '无法读取官方观时上报状态')) })
    return () => { live = false; unsubscribe() }
  }, [])
  return { state, error }
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
  const [error, setError, errorDetail] = useErrorState('')
  const [refreshing, setRefreshing] = useState(false)
  const [watch, setWatch] = useState<Watch>({ kind: 'loading' })
  const [fansWatch, setFansWatch] = useState<DouyuFansWatchTime | null>(null)
  const [fansRead, setFansRead] = useState<(DouyuWatchRead & { room: string }) | null>(null)
  const [watchAccount, setWatchAccount] = useState<string | null | undefined>(undefined)
  const [fansWatchError, setFansWatchError, fansWatchErrorDetail] = useErrorState('')
  const { state: watchState, error: watchStateError } = useWatchState()
  const sequence = useRef(0)
  const watchSequence = useRef(0)
  const watchScope = useRef<string | null>(null)
  const applied = useRef(0)
  const alive = useRef(true)
  const roomRef = useRef(room)
  roomRef.current = room

  /** Apply a snapshot only for the room still shown, and only if nothing later has landed. */
  const accept = (target: string, mine: number, result: ApiResult<DouyuRoomInsights>): void => {
    if (!alive.current || target !== roomRef.current || mine < applied.current) return
    applied.current = mine
    if (!result.ok) { setError(result); return }
    if (!validInsights(result.value, target)) { setError(displayError(result, '无法读取房间数据')); return }
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
    watchScope.current = null
    setWatch({ kind: 'loading' })
    setFansWatch(null)
    setFansRead(null)
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
      }).catch(caught => {
        if (!live || mine < applied.current) return
        applied.current = mine
        setError(displayError(caught, '无法读取房间数据'))
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
    const unsubscribeAccounts = apiClient.subscribeDouyuAccounts(accounts => {
      if (!live || watchScope.current === accountScope(room, accounts)) return
      void readWatch(room, accounts)
    })
    const timer = setInterval(() => { read(true); void readWatch(room) }, 60_000)
    void readWatch(room)
    return () => { live = false; alive.current = false; clearInterval(timer); unsubscribe(); unsubscribeAccounts() }
  }, [room])

  const current = (target: string): boolean => alive.current && roomRef.current === target

  async function readWatch(target: string, snapshot?: DouyuAccountsSnapshot): Promise<void> {
    const mine = ++watchSequence.current
    setFansWatchError('')
    const accounts = snapshot ? { ok: true as const, value: snapshot }
      : await apiClient.listDouyuAccounts().catch(caught => ({ ok: false as const, ...displayError(caught, '无法读取当前账号') }))
    if (!current(target) || mine !== watchSequence.current) return
    const scope = accounts.ok ? accountScope(target, accounts.value) : null
    if (!scope || scope !== watchScope.current) {
      watchScope.current = scope
      setWatch({ kind: 'loading' })
      setFansWatch(null)
      setFansRead(null)
    }
    if (!accounts.ok) { setWatchAccount(null); setWatch({ kind: 'missing', reason: accounts.message, detail: errorDetails(accounts) }); return }
    const active = accounts.value.accounts.find((account) => account.id === accounts.value.activeAccountId)
    setWatchAccount(active?.login.loggedIn && !active.busy ? active.id : null)
    if (!active) { setWatch({ kind: 'missing', reason: '未设置当前账号' }); return }
    if (!active.login.loggedIn || active.busy) { setWatch({ kind: 'missing', reason: active.busy ? '等待读取当前账号' : '当前账号未登录' }); return }
    const requestedDay = douyuWatchDay(Date.now())
    const [daily, cumulative] = await Promise.allSettled([
      apiClient.feature('getDouyuWatchTime', { accountId: active.id, room: target, refresh: true }),
      apiClient.feature('getDouyuFansWatchTime', { accountId: active.id, room: target, refresh: true }),
    ])
    if (!current(target) || mine !== watchSequence.current) return
    const at = Date.now()
    const bound = (value: DouyuWatchTime | DouyuFansWatchTime) => value.accountId === active.id && value.room === target
    if (cumulative.status === 'fulfilled' && cumulative.value.ok && bound(cumulative.value.value)
      && cumulative.value.value.source === 'douyu-fanshome-cumulative') {
      const result = cumulative.value.value
      setFansWatch(previous => result.seconds === null && previous?.seconds != null
        ? { ...previous, badgeOwned: result.badgeOwned, badgeLevel: result.badgeLevel } : result)
      setFansRead({ room: target, at, status: result.seconds === null ? 'missing' : 'available' })
    } else {
      setFansRead({ room: target, at, status: 'failed' })
      const failure = cumulative.status === 'rejected' ? cumulative.reason : cumulative.value
      setFansWatchError(displayError(failure, cumulative.status === 'fulfilled' && !cumulative.value.ok ? cumulative.value.message : '粉丝牌累计观看查询失败'))
    }
    const result = daily.status === 'fulfilled' && daily.value.ok ? daily.value.value : null
    if (requestedDay !== douyuWatchDay(at)) return
    if (result && bound(result) && result.source === 'douyu-today-watch' && result.seconds !== null) {
      setWatch({ kind: 'value', value: result, read: { at, status: 'available' } })
    } else {
      const missing = !!(result && bound(result) && result.source === 'douyu-today-watch')
      const failure = daily.status === 'rejected' ? daily.reason : daily.value
      const read: DouyuWatchRead = { at, status: missing ? 'missing' : 'failed' }
      setWatch(previous => previous.kind === 'value' && bound(previous.value) && douyuWatchDay(previous.value.checkedAt) === requestedDay
        ? { ...previous, read }
        : { kind: 'missing', reason: missing ? `平台未返回今日观看, 复查于 ${formatWatchTime(at)}.` : '官方今日观看查询失败',
          detail: missing ? undefined : errorDetails(failure), read })
    }
  }

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    const mine = ++sequence.current
    void Promise.all([
      apiClient.feature('refreshDouyuRoomInsights', { room }).then((result) => accept(room, mine, result)),
      readWatch(room),
    ]).catch(caught => { if (alive.current) setError(displayError(caught, '房间数据刷新失败')) }).finally(() => { if (alive.current) setRefreshing(false) })
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
        {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
        {watchStateError && <p className="form-error" role="alert"><ErrorText error={watchStateError.detail} message={watchStateError.message} /></p>}
        {fansWatchError && <p className="form-error" role="alert"><ErrorText error={fansWatchErrorDetail ?? fansWatchError} message={fansWatchError} /></p>}
        {!insights && !error && <p className="lane" role="status">正在读取房间数据</p>}
        {insights && tab === 'overview' && <Overview insights={insights} watch={watch} watchState={watchState} watchAccount={watchAccount}
          fansWatch={fansWatch} fansRead={fansRead?.room === room ? fansRead : null} />}
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

function Overview({ insights, watch, watchState, watchAccount, fansWatch, fansRead }: { insights: DouyuRoomInsights; watch: Watch;
  watchState: DouyuWatchState | null; watchAccount?: string | null; fansWatch: DouyuFansWatchTime | null;
  fansRead: DouyuWatchRead | null }): React.ReactNode {
  const { coverage, gifts, nobles } = insights
  const live = insights.live === true && insights.replay === false
  const unknownGifts = gifts.unknownValueCount > 0
  const giftValue = gifts.totalValueMinor !== null ? `${formatMinor(gifts.totalValueMinor)} 鱼翅` : UNKNOWN
  const updated = `更新于 ${formatTime(insights.checkedAt)}`
  const accountAgrees = !watchState || watchAccount === undefined || watchAccount === watchState.accountId
  const active = accountAgrees && watchState?.room === insights.room ? watchState : null
  let officialWatch: Watch = watch
  if (watchState?.phase === 'login-required' || (watchState && !watchState.accountId)) {
    officialWatch = { kind: 'missing', reason: '当前账号未登录或未设置' }
  } else {
    const manual = watch.kind === 'value' && watch.value.room === insights.room && (!watchState || watch.value.accountId === watchState.accountId) ? watch : null
    const automatic = active?.accountId && active.checkedAt !== null && active.officialSeconds !== null
      ? { accountId: active.accountId, room: insights.room, checkedAt: active.checkedAt, seconds: active.officialSeconds, source: 'douyu-today-watch' as const }
      : null
    const value = automatic && automatic.checkedAt >= (manual?.value.checkedAt ?? -1) ? automatic : manual?.value
    if (value && douyuWatchDay(value.checkedAt) === douyuWatchDay(Date.now())) {
      const manualRead = watch.kind === 'missing' && accountAgrees ? watch.read : manual?.read
      const read = latestRead(active?.dailyRead, manualRead)
      officialWatch = { kind: 'value', value, read, baseline: active?.baselineSeconds }
    } else if (watch.kind === 'value') {
      officialWatch = { kind: 'missing', reason: '当前账号官方观看时长尚未读取' }
    }
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
          <FansWatchStat state={active} value={accountAgrees ? fansWatch : null}
            manualRead={accountAgrees && watchState?.phase !== 'login-required' ? fansRead : null} room={insights.room} />
          <WatchSessionStat state={watchState?.phase === 'login-required' ? watchState : active} room={insights.room} />
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
  return <Stat label="官方观时上报" value={phase ? labels[phase] : '尚未启动'} note={phase === 'failed' ? <ErrorText error={active} message={note} /> : note} />
}

function latestRead(first?: DouyuWatchRead | null, second?: DouyuWatchRead | null): DouyuWatchRead | null {
  return second && second.at >= (first?.at ?? -1) ? second : first ?? null
}

const watchTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const formatWatchTime = (at: number | null): string => at === null ? UNKNOWN : `${watchTimeFormat.format(at)} (UTC+8)`

function readNote(read: DouyuWatchRead | null | undefined): string {
  if (!read || read.status === 'available') return ''
  return ` 复查于 ${formatWatchTime(read.at)}, ${read.status === 'failed' ? '查询失败' : '平台未返回本项读数'}.`
}

function comparison(seconds: number | null, baseline: number | null | undefined, checkedAt: number | null, read?: DouyuWatchRead | null): string {
  const lastValue = seconds === null ? '' : ` ${read && read.status !== 'available' ? '上次有效读数' : '官方原值'} ${seconds} 秒, 读取于 ${formatWatchTime(checkedAt)}.`
  const delta = seconds !== null && baseline != null && seconds >= baseline && (!read || read.status === 'available')
    ? ` 播放基线 ${baseline} 秒, 差额 ${seconds - baseline} 秒.` : ''
  return `${lastValue}${delta}${readNote(read)}`
}

function FansWatchStat({ state, value, manualRead, room }: { state: DouyuWatchState | null; value: DouyuFansWatchTime | null;
  manualRead: DouyuWatchRead | null; room: string }): React.ReactNode {
  const active = state?.room === room && state.phase !== 'login-required' ? state : null
  const accountValid = state?.phase !== 'login-required' && value?.room === room && (!state || value.accountId === state.accountId)
  const manual = accountValid ? value : null
  const useActive = !!active && active.cumulativeCheckedAt !== null && active.cumulativeCheckedAt >= (manual?.checkedAt ?? -1)
  const seconds = useActive ? active.cumulativeSeconds : manual?.seconds ?? null
  const checkedAt = useActive ? active.cumulativeCheckedAt : manual?.checkedAt ?? null
  const read = latestRead(active?.cumulativeRead, manualRead)
  const usesManualBadge = !!manual && (manualRead?.at ?? manual.checkedAt) >= (active?.cumulativeRead?.at ?? -1)
  const owned = read?.status === 'failed' ? null : usesManualBadge ? manual.badgeOwned : active?.badgeOwned ?? null
  const level = usesManualBadge ? manual.badgeLevel : active?.badgeLevel ?? null
  const badge = owned === true ? `已持有${level === null ? '' : ` ${level} 级`}粉丝牌.` : owned === false ? '当前账号未持有此房间粉丝牌.' : '粉丝牌持有状态未确认.'
  const detail = comparison(seconds, owned === true ? active?.cumulativeBaselineSeconds : null, checkedAt, read)
  return <Stat label="粉丝牌累计观看" value={formatDuration(seconds)} note={`${badge}${detail} 来源为斗鱼粉丝家园累计观看.`} />
}

function WatchStat({ watch }: { watch: Watch }): React.ReactNode {
  if (watch.kind === 'loading') return <Stat label="官方今日观看" value={UNKNOWN} note="正在读取" />
  if (watch.kind === 'missing') return <Stat label="官方今日观看" value={UNKNOWN} note={watch.detail ? <ErrorText error={watch.detail} message={watch.reason} /> : watch.reason} />
  const { seconds, checkedAt } = watch.value
  return (
    <Stat label="官方今日观看" value={formatDuration(seconds)}
      note={`来源为斗鱼今日观看.${comparison(seconds, watch.baseline, checkedAt, watch.read)}`} />
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
