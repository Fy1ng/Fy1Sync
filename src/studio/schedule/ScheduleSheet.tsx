/**
 * 赛程: the CS2 matches on now and next, by event, so the official picture is picked by who is
 * playing rather than by pasting a link.
 *
 * Events down the left (live ones first); the chosen event's matches on the right, grouped
 * into 进行中 / 即将开始 / 已结束. Each match lists the streams it can be watched on, with
 * the broadcast's own title when it is known, so two stages of one event can be told apart.
 * Picking a stream loads it as 画面 and closes the sheet. A stream that names no video waits
 * for main to find its channel on the event page; until then its button is off and the row
 * says why.
 *
 * The data is Liquipedia's (CC-BY-SA 3.0); main rate-limits and caches it, and the footer
 * says where it came from and how old it is.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { Cs2Match, Cs2Schedule, Cs2Stream, StreamTitle } from '../../../electron/featureContracts'
import { Icon, Sheet, SideTabs } from '../kit'
import { eventPath, formatStart, groupEvents, matchStage, MISSING_TEXT, orderedStreams, PLATFORM_NAME, streamKey, streamTitle, tierLabel, titleKey, titleRequests, type EventGroup } from './model'
import { lastSchedule, onSchedule, readSchedule, refreshScheduleAfterVerification, scheduleChanged } from './store'
import './schedule.css'
import { useRemembered } from '../../app/remembered'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'

/** How often the open sheet asks again. Main serves its cache in between, so this is cheap. */
const POLL_MS = 60_000
type RefreshBlock = { at: number; reason: NonNullable<Cs2Schedule['refreshReason']>; fetchedAt: number }
const retryLabel = (seconds: number): string => seconds >= 3600 ? `${Math.ceil(seconds / 3600)} 小时`
  : seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${seconds} 秒`

export function ScheduleSheet({ onClose, onWatch }: {
  onClose: () => void
  /** Load this stream as 画面. Progress and failure show behind the sheet, on the 画面 slot. */
  onWatch: (url: string) => void
}): React.ReactNode {
  // Open on what the start-up read found; the read below only brings it up to date.
  const [schedule, setSchedule] = useState<Cs2Schedule | null>(lastSchedule)
  const [failure, setFailure, failureDetail] = useErrorState()
  const [refreshing, setRefreshing] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  const [refreshBlock, setRefreshBlock] = useState<RefreshBlock | null>(() => {
    const value = lastSchedule()
    return value?.refreshAt && value.refreshAt > Date.now()
      ? { at: value.refreshAt, reason: value.refreshReason ?? 'parse-quota', fetchedAt: value.fetchedAt } : null
  })
  const acceptCooldown = useCallback((value: Cs2Schedule, explicit = false): void => {
    setRefreshBlock(previous => {
      const at = value.refreshAt
      if (typeof at === 'number' && Number.isFinite(at) && at > Date.now()) {
        return { at: explicit || value.verification ? at : Math.max(previous?.at ?? 0, at),
          reason: value.refreshReason ?? 'parse-quota', fetchedAt: value.fetchedAt }
      }
      if (explicit || (previous && previous.reason !== 'parse-quota' && !value.stale && value.fetchedAt > previous.fetchedAt)) return null
      return previous
    })
  }, [])
  const refreshAt = refreshBlock?.at ?? null
  // The chosen event and the titles read so far survive closing the sheet.
  const [eventKey, setEventKey] = useRemembered<string | null>('schedule:event', null)
  const [titles, setTitles] = useRemembered<Map<string, StreamTitle>>('schedule:titles', new Map())
  const [now, setNow] = useState(Date.now)
  const alive = useRef(true)
  const titleRun = useRef(0)

  const read = async (refresh: boolean): Promise<void> => {
    const before = lastSchedule()
    if (refresh) { setRefreshing(true); setRefreshMessage(null) }
    const result = await readSchedule(refresh)
    if (!alive.current) return
    if (refresh) setRefreshing(false)
    setNow(Date.now())
    if (!result.ok) { setFailure(result); return }
    setFailure(null)
    // The store rejects out-of-order replies; an older sheet read must not undo that.
    const next = lastSchedule() ?? result.value
    setSchedule(next)
    if (refresh && !next.stale && !result.value.refreshAt) {
      setRefreshMessage(before && JSON.stringify(before.matches) === JSON.stringify(next.matches)
        ? '赛程暂无变化' : '赛程已更新')
    }
    acceptCooldown(next, refresh)
  }

  const retryAfterVerification = async (round: string): Promise<void> => {
    setVerifying(true)
    setRefreshMessage(null)
    try {
      const result = await refreshScheduleAfterVerification(round)
      if (!alive.current) return
      setNow(Date.now())
      if (!result.ok) { setFailure(result); return }
      const next = lastSchedule() ?? result.value
      acceptCooldown(next, true)
      switch (result.value.verificationResult) {
        case 'recovered':
          if (!next.verification) setRefreshMessage('赛程已更新')
          break
        case 'rate-limited': setRefreshMessage('验证未对应用的请求生效，仍受 Liquipedia 限流'); break
        case 'failed': setRefreshMessage('未能读取赛程，冷却未解除'); break
      }
    } finally { if (alive.current) setVerifying(false) }
  }

  // Count down once a second while held back, and free the button when the time comes.
  const waitSeconds = refreshAt === null ? 0 : Math.max(0, Math.ceil((refreshAt - now) / 1000))
  useEffect(() => {
    if (refreshAt === null) return
    if (refreshAt <= Date.now()) { setRefreshBlock(null); return }
    const timer = window.setTimeout(() => setNow(Date.now()), 1000 - (Date.now() % 1000) || 1000)
    return () => window.clearTimeout(timer)
  }, [refreshAt, now])

  useEffect(() => {
    alive.current = true
    void read(false)
    const timer = window.setInterval(() => void read(false), POLL_MS)
    // Main says when tiers and crests land and the store reads again (once more if a read was
    // in flight); take every schedule it keeps rather than waiting for the next poll.
    const offRead = onSchedule((value) => { if (alive.current) { setFailure(null); setSchedule(value); acceptCooldown(value) } })
    const off = apiClient.subscribeFeatures((event) => { if (event.topic === 'cs2-schedule') scheduleChanged() })
    return () => { alive.current = false; window.clearInterval(timer); off(); offRead() }
  }, [])

  const events = useMemo(() => groupEvents(schedule), [schedule])
  const upstreamLimited = waitSeconds > 0 && (schedule?.refreshReason === 'upstream-rate-limit' || (schedule?.stale && schedule.errorDetail?.status === 429))
  const verification = schedule?.verification
  const current = events.find((group) => group.key === eventKey) ?? events[0]
  useEffect(() => { if (current && current.key !== eventKey) setEventKey(current.key) }, [current, eventKey])

  // Main fetches the shown event's missing crests next; tell it which one that is, and that
  // none is once the sheet closes. Keyed on the path, so crest and tier updates resend nothing.
  const focus = eventPath(current)
  useEffect(() => { void apiClient.feature('setCs2ScheduleFocus', { eventPath: focus }) }, [focus])
  useEffect(() => () => { void apiClient.feature('setCs2ScheduleFocus', { eventPath: null }) }, [])

  // Titles for the chosen event's live and next streams, read in one batch per change.
  const requestKey = JSON.stringify(titleRequests(current))
  useEffect(() => {
    const streams = JSON.parse(requestKey) as ReturnType<typeof titleRequests>
    if (streams.length === 0) return
    const run = ++titleRun.current
    void apiClient.feature('getStreamTitles', { streams }).then((result) => {
      if (!alive.current || run !== titleRun.current || !result.ok) return
      setTitles((previous) => {
        const next = new Map(previous)
        for (const title of result.value) next.set(titleKey(title), title)
        return next
      })
    })
  }, [requestKey])

  // The pick closes the sheet at once; 添加直播间 or the source chip behind it shows the load.
  const watch = (stream: Cs2Stream): void => {
    if (!stream.url) return
    onWatch(stream.url)
    onClose()
  }

  const tabs = events.map((group) => {
    const tier = tierLabel(group.tier)
    return {
      id: group.key,
      label: group.name,
      icon: <EventIcon src={group.logo} />,
      badge: (tier || group.live.length > 0) ? (
        <span className="sched-badges">
          {group.live.length > 0 && <span className="sched-live-dot" aria-label={`${group.live.length} 场进行中`} />}
          {tier && <span className="sched-tier" data-tier={group.tier} aria-label={`${tier} 级赛事`}>{tier}</span>}
        </span>
      ) : undefined,
    }
  })

  return (
    <Sheet title="赛程" onClose={onClose} wide>
      <div className="sched">
        {events.length === 0 ? (
          <div className="sched-empty">
            <div className="sched-empty-content">
              {failure || schedule?.error ? <ErrorText error={failure ? failureDetail ?? failure : schedule?.errorDetail ?? { message: schedule?.error }} message={failure || schedule?.error} />
                : schedule ? '近两天没有登记的 CS2 比赛' : '正在读取赛程'}
            </div>
          </div>
        ) : (
          <SideTabs label="赛事" value={current?.key ?? ''} onChange={setEventKey} tabs={tabs}>
            {current && (
              <EventPane group={current} titles={titles} now={now} onWatch={watch} />
            )}
          </SideTabs>
        )}
        <footer className="sched-foot">
          {refreshMessage && <p role="status">{refreshMessage}</p>}
          {schedule?.stale && events.length > 0 && <p className="note-warn"><ErrorText error={schedule.errorDetail ?? { message: schedule.error, fetchedAt: schedule.fetchedAt, stale: true }} message={schedule.error ?? '更新失败，显示上次赛程'} /></p>}
          {upstreamLimited && <LiquipediaVerification key={verification?.round} attempt={verification}
            waiting={verifying} now={now} onRetry={retryAfterVerification} />}
          <span className="sched-source">
            {schedule ? `${schedule.attribution} - ${schedule.fetchedAt > 0 ? `读取于 ${formatStart(schedule.fetchedAt, now)}` : '暂未获取'}` : '赛程数据来自 Liquipedia（CC-BY-SA 3.0）'}
          </span>
          <button type="button" className="btn-quiet small" disabled={refreshing || verifying || waitSeconds > 0} onClick={() => void read(true)}>
            <Icon name="refresh" />{refreshing ? '正在刷新' : waitSeconds > 0 ? `${retryLabel(waitSeconds)}后可刷新` : '刷新'}
          </button>
        </footer>
      </div>
    </Sheet>
  )
}

/** Browser handoff is explicit and does not reset request quotas or infer verification success. */
function LiquipediaVerification({ attempt, waiting, now, onRetry }: {
  attempt: Cs2Schedule['verification']; waiting: boolean; now: number; onRetry: (round: string) => Promise<void>
}): React.ReactNode {
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError, errorDetail] = useErrorState()
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const open = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setOpening(true); setOpened(false); setError(null)
    try {
      const result = await apiClient.feature('openLiquipediaVerification', undefined)
      if (!mounted.current) return
      if (result.ok) setOpened(true)
      else setError(displayError(result, '无法打开官网验证页面，请重试'))
    } catch (caught) {
      if (mounted.current) setError(displayError(caught, '无法打开官网验证页面，请重试'))
    } finally {
      pending.current = false
      if (mounted.current) setOpening(false)
    }
  }

  const untilUpstream = !!attempt && attempt.notBefore > now
  return <div className="sched-verification" role="group" aria-label="Liquipedia 官网验证">
    <button type="button" className="btn-solid small" disabled={opening || waiting} onClick={() => void open()}>
      <Icon name="link" />{opening ? '正在打开官网' : '打开官网验证'}
    </button>
    {opened && attempt && <button type="button" className="btn-quiet small" disabled={waiting || untilUpstream || attempt.used}
      onClick={() => void onRetry(attempt.round)}>
      <Icon name="refresh" />{waiting ? '正在等待刷新' : attempt.used ? '本轮已尝试'
        : untilUpstream ? `最早可试：${new Date(attempt.notBefore).toLocaleString('zh-CN', { hour12: false })}` : '已完成验证，立即刷新'}
    </button>}
    <span className="muted">如官网要求验证，请使用与应用相同的网络和代理，完成后返回刷新</span>
    {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
  </div>
}

function EventPane({ group, titles, now, onWatch }: {
  group: EventGroup
  titles: ReadonlyMap<string, StreamTitle>
  now: number
  onWatch: (stream: Cs2Stream) => void
}): React.ReactNode {
  const sections: { id: keyof Pick<EventGroup, 'live' | 'upcoming' | 'finished'>; label: string }[] = [
    { id: 'live', label: '进行中' },
    { id: 'upcoming', label: '即将开始' },
    { id: 'finished', label: '已结束' },
  ]
  return (
    <div className="sched-pane">
      <h3 className="sched-event display">
        {group.logo && <EventIcon src={group.logo} />}
        {group.name}
        {tierLabel(group.tier) && <span className="sched-tier" data-tier={group.tier}>{tierLabel(group.tier)} 级</span>}
      </h3>
      {sections.map((section) => group[section.id].length > 0 && (
        <section key={section.id} className="sched-section" aria-label={section.label}>
          <h4>{section.label}</h4>
          <ul className="sched-list">
            {group[section.id].map((match) => (
              <MatchRow key={match.id} match={match} titles={titles} now={now}
                siblingsLive={group.live.length} onWatch={onWatch} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function MatchRow({ match, titles, now, siblingsLive, onWatch }: {
  match: Cs2Match
  titles: ReadonlyMap<string, StreamTitle>
  now: number
  siblingsLive: number
  onWatch: (stream: Cs2Stream) => void
}): React.ReactNode {
  const [left, right] = match.teams
  const stage = matchStage(match, titles, siblingsLive)
  const streams = orderedStreams(match)
  const title = streams.map((stream) => streamTitle(titles, stream)?.title).find(Boolean)
  const label = `${left.name} 对 ${right.name}`
  const winner = match.state === 'finished' && match.score ? (match.score[0] > match.score[1] ? 0 : match.score[1] > match.score[0] ? 1 : -1) : -1
  const awaitingScore = match.state === 'live' && match.score?.[0] === 0 && match.score[1] === 0
  // With nothing to play yet, say why once, from the first stream still waiting for its channel.
  const waiting = streams.some((stream) => stream.url) ? null : streams.find((stream) => stream.missing)?.missing ?? null
  return (
    <li className="match" data-state={match.state} aria-label={label}>
      <div className="match-when">
        {match.state === 'live'
          ? <span className={awaitingScore ? 'muted' : 'match-live'}
              title={awaitingScore ? '比分尚未更新，以直播画面为准' : undefined}>
              {awaitingScore ? '赛果待更新' : '直播中'}
            </span>
          : <span className="num">{formatStart(match.startsAt, now)}</span>}
        {match.bestOf && <span className="match-bo">BO{match.bestOf}</span>}
      </div>
      <div className="match-teams">
        <span className={`match-team${winner === 0 ? ' is-win' : ''}`}><TeamName team={left} /></span>
        <span className="match-score num">
          {match.score ? <>{match.score[0]}<i>:</i>{match.score[1]}</> : 'vs'}
        </span>
        <span className={`match-team is-right${winner === 1 ? ' is-win' : ''}`}><TeamName team={right} logoFirst /></span>
      </div>
      <div className="match-meta">
        {stage && <span className="match-stage" data-from={stage.from}>{stage.label}</span>}
        {match.tournament.stage && <span>{match.tournament.stage}</span>}
        {title && <span className="match-title" title={title}>{title}</span>}
        {waiting && <span className="match-missing" data-missing={waiting}>{waiting === 'failed'
          ? <ErrorText error={streams.find(stream => stream.missing === 'failed')?.errorDetail ?? { code: 'stream-channel-failed', message: MISSING_TEXT.failed }} message={MISSING_TEXT.failed} /> : MISSING_TEXT[waiting]}</span>}
      </div>
      <div className="match-watch">
        {streams.length === 0
          ? <span className="muted">未登记直播</span>
          : streams.map((stream, index) => {
            const known = streamTitle(titles, stream)
            const off = known?.live === false
            const name = stream.channel ?? stream.entry
            // One obvious choice per live match: the first playable stream.
            const primary = match.state === 'live' && !off && index === streams.findIndex((item) => item.url && streamTitle(titles, item)?.live !== false)
            return (
              <button key={streamKey(stream)} type="button" className={primary ? 'btn-solid small' : 'btn-quiet small'}
                disabled={!stream.url} onClick={() => onWatch(stream)}
                aria-label={`在 ${PLATFORM_NAME[stream.platform]} 观看 ${label}（${name}）`}
                title={stream.missing ? MISSING_TEXT[stream.missing] : `${PLATFORM_NAME[stream.platform]} · ${name}${off ? ' · 未在直播' : ''}`}>
                {PLATFORM_NAME[stream.platform]}
              </button>
            )
          })}
      </div>
    </li>
  )
}

/**
 * An event's icon, main's cached copy, in a fixed box so event names line up; an event without
 * one, or an icon that fails to load, leaves the box empty. A new address is tried again.
 */
function EventIcon({ src }: { src: string | null }): React.ReactNode {
  const [failed, setFailed] = useState<string | null>(null)
  return src && failed !== src
    ? <img className="sched-icon" src={src} alt="" draggable={false} onError={() => setFailed(src)} />
    : <span className="sched-icon" aria-hidden="true" />
}

/**
 * A team as the broadcast shows it: crest beside the name, facing the score. The crest is
 * main's cached copy (`app://app/team-logo/…`); a team without one, or a crest that fails to
 * load, keeps an empty slot of the same width so the names stay in line. A failure belongs to
 * that address: a new one (the crest replaced, or arriving later) is tried again.
 */
export function TeamName({ team, logoFirst = false }: { team: Cs2Match['teams'][number]; logoFirst?: boolean }): React.ReactNode {
  const [failed, setFailed] = useState<string | null>(null)
  const logo = team.logo
  const crest = logo && failed !== logo
    ? <img className="match-logo" src={logo} alt="" draggable={false} onError={() => setFailed(logo)} />
    : <span className="match-logo is-empty" aria-hidden="true" />
  return <>{logoFirst && crest}<span className="match-team-name">{team.name}</span>{!logoFirst && crest}</>
}
