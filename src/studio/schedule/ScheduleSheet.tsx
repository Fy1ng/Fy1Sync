/**
 * 赛程: the CS2 matches on now and next, by event, so the official picture is picked by who is
 * playing rather than by pasting a link.
 *
 * Events down the left (live ones first); the chosen event's matches on the right, grouped
 * into 进行中 / 即将开始 / 已结束. Each match lists the streams it can be watched on, with
 * the broadcast's own title when it is known, so two stages of one event can be told apart.
 * Picking a stream loads it as 画面 and closes the sheet.
 *
 * The data is Liquipedia's (CC-BY-SA 3.0); main rate-limits and caches it, and the footer
 * says where it came from and how old it is.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { Cs2Match, Cs2Schedule, Cs2Stream, StreamTitle } from '../../../electron/featureContracts'
import { Icon, Sheet, SideTabs } from '../kit'
import { formatStart, groupEvents, matchStage, orderedStreams, PLATFORM_NAME, streamKey, tierLabel, titleRequests, type EventGroup } from './model'
import './schedule.css'

/** How often the open sheet asks again. Main serves its cache in between, so this is cheap. */
const POLL_MS = 60_000

export function ScheduleSheet({ onClose, onWatch }: {
  onClose: () => void
  /** Load this stream as 画面. Resolves true when it played. */
  onWatch: (url: string) => Promise<boolean>
}): React.ReactNode {
  const [schedule, setSchedule] = useState<Cs2Schedule | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [eventKey, setEventKey] = useState<string | null>(null)
  const [titles, setTitles] = useState<Map<string, StreamTitle>>(() => new Map())
  const [loading, setLoading] = useState<string | null>(null)
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const alive = useRef(true)
  const titleRun = useRef(0)

  const read = async (refresh: boolean): Promise<void> => {
    if (refresh) setRefreshing(true)
    const result = await apiClient.feature('getCs2Schedule', refresh ? { refresh: true } : undefined)
    if (!alive.current) return
    if (refresh) setRefreshing(false)
    setNow(Date.now())
    if (!result.ok) { setFailure(result.message); return }
    setFailure(null)
    setSchedule(result.value)
  }

  useEffect(() => {
    alive.current = true
    void read(false)
    const timer = window.setInterval(() => void read(false), POLL_MS)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [])

  const events = useMemo(() => groupEvents(schedule), [schedule])
  const current = events.find((group) => group.key === eventKey) ?? events[0]
  useEffect(() => { if (current && current.key !== eventKey) setEventKey(current.key) }, [current, eventKey])

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
        for (const title of result.value) next.set(streamKey(title), title)
        return next
      })
    })
  }, [requestKey])

  const watch = async (stream: Cs2Stream): Promise<void> => {
    if (loading) return
    setLoading(streamKey(stream))
    setLoadProblem(null)
    const ok = await onWatch(stream.url)
    if (!alive.current) return
    setLoading(null)
    if (ok) onClose()
    else setLoadProblem('该直播流未能载入，可能尚未开播或已结束，可换另一个平台重试')
  }

  const tabs = events.map((group) => {
    const tier = tierLabel(group.tier)
    return {
      id: group.key,
      label: group.name,
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
            {failure ?? schedule?.error ?? (schedule ? '近两天没有登记的 CS2 比赛' : '正在读取赛程')}
          </div>
        ) : (
          <SideTabs label="赛事" value={current?.key ?? ''} onChange={setEventKey} tabs={tabs}>
            {current && (
              <EventPane group={current} titles={titles} now={now} loading={loading} onWatch={(stream) => void watch(stream)} />
            )}
          </SideTabs>
        )}
        <footer className="sched-foot">
          {loadProblem && <p className="form-error" role="alert">{loadProblem}</p>}
          {schedule?.stale && <p className="note-warn">{schedule.error ?? '赛程暂时无法更新，显示的是上次读取的结果'}</p>}
          <span className="sched-source">
            {schedule ? `${schedule.attribution} · 更新于 ${formatStart(schedule.fetchedAt, now)}` : '赛程数据来自 Liquipedia (CC-BY-SA 3.0)'}
          </span>
          <button type="button" className="btn-quiet small" disabled={refreshing} onClick={() => void read(true)}>
            <Icon name="refresh" />{refreshing ? '正在刷新' : '刷新'}
          </button>
        </footer>
      </div>
    </Sheet>
  )
}

function EventPane({ group, titles, now, loading, onWatch }: {
  group: EventGroup
  titles: ReadonlyMap<string, StreamTitle>
  now: number
  loading: string | null
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
        {group.name}
        {tierLabel(group.tier) && <span className="sched-tier" data-tier={group.tier}>{tierLabel(group.tier)} 级</span>}
      </h3>
      {sections.map((section) => group[section.id].length > 0 && (
        <section key={section.id} className="sched-section" aria-label={section.label}>
          <h4>{section.label}</h4>
          <ul className="sched-list">
            {group[section.id].map((match) => (
              <MatchRow key={match.id} match={match} titles={titles} now={now} loading={loading}
                siblingsLive={group.live.length} onWatch={onWatch} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function MatchRow({ match, titles, now, loading, siblingsLive, onWatch }: {
  match: Cs2Match
  titles: ReadonlyMap<string, StreamTitle>
  now: number
  loading: string | null
  siblingsLive: number
  onWatch: (stream: Cs2Stream) => void
}): React.ReactNode {
  const [left, right] = match.teams
  const stage = matchStage(match, titles, siblingsLive)
  const streams = orderedStreams(match)
  const title = streams.map((stream) => titles.get(streamKey(stream))?.title).find(Boolean)
  const label = `${left.name} 对 ${right.name}`
  const winner = match.state === 'finished' && match.score ? (match.score[0] > match.score[1] ? 0 : match.score[1] > match.score[0] ? 1 : -1) : -1
  return (
    <li className="match" data-state={match.state} aria-label={label}>
      <div className="match-when">
        {match.state === 'live'
          ? <span className="match-live">直播中</span>
          : <span className="num">{formatStart(match.startsAt, now)}</span>}
        {match.bestOf && <span className="match-bo">BO{match.bestOf}</span>}
      </div>
      <div className="match-teams">
        <span className={`match-team${winner === 0 ? ' is-win' : ''}`}>{left.name}</span>
        <span className="match-score num">
          {match.score ? <>{match.score[0]}<i>:</i>{match.score[1]}</> : 'vs'}
        </span>
        <span className={`match-team is-right${winner === 1 ? ' is-win' : ''}`}>{right.name}</span>
      </div>
      <div className="match-meta">
        {stage && <span className="match-stage" data-from={stage.from}>{stage.label}</span>}
        {match.tournament.stage && <span>{match.tournament.stage}</span>}
        {title && <span className="match-title" title={title}>{title}</span>}
      </div>
      <div className="match-watch">
        {streams.length === 0
          ? <span className="muted">未登记直播</span>
          : streams.map((stream, index) => {
            const key = streamKey(stream)
            const known = titles.get(key)
            const off = known?.live === false
            // One obvious choice per live match: the first playable stream.
            const primary = match.state === 'live' && !off && index === streams.findIndex((item) => titles.get(streamKey(item))?.live !== false)
            return (
              <button key={key} type="button" className={primary ? 'btn-solid small' : 'btn-quiet small'}
                disabled={loading !== null} onClick={() => onWatch(stream)}
                aria-label={`在${PLATFORM_NAME[stream.platform]}观看 ${label}（${stream.channel}）`}
                title={`${PLATFORM_NAME[stream.platform]} · ${stream.channel}${off ? ' · 未在直播' : ''}`}>
                {loading === key ? '正在载入' : PLATFORM_NAME[stream.platform]}
              </button>
            )
          })}
      </div>
    </li>
  )
}
