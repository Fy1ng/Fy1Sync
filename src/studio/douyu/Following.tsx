/**
 * Followed rooms with quick open, and live notifications (handoff items 75, 69).
 *
 * The list is read for the current account only and says how much of it was read. A row
 * can be watched as the commentary side or opened as an extra stream on the same screen;
 * neither follows, signs in or touches the room otherwise. Live-notification settings and
 * the notices they produce are kept in `followingNotices`, so they outlive this tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import { useSession } from '../../app/SessionContext'
import type { DouyuFollowedRoom, DouyuFollowedRooms } from '../../../server/douyu/insightsTypes'
import { Icon, Segmented, Switch } from '../kit'
import { formatDuration, formatTime } from '../insights/format'
import {
  applyLiveNotices, dismissLiveNotice, draftLiveNotices, MAX_NOTIFY_ROOMS, rememberRoomNames, setNoticeSink,
  stopForAccountChange, useLiveNotices, type NotifyScope,
} from './followingNotices'
import type { DouyuData } from './useDouyu'
import './following.css'
import { useRemembered } from '../../app/remembered'

const SCOPES: { value: NotifyScope; label: string }[] = [
  { value: 'selected', label: '所选房间' },
  { value: 'all', label: '全部关注' },
]

type RowNote = { text: string; error: boolean }

const isLive = (room: DouyuFollowedRoom): boolean => room.live === true && room.replay !== true

function stateOf(room: DouyuFollowedRoom): { label: string; tone: string } {
  if (room.replay === true) return { label: '回放', tone: 'replay' }
  if (room.live === true) return { label: '直播中', tone: 'live' }
  if (room.live === false) return { label: '未开播', tone: 'off' }
  return { label: '状态未知', tone: 'unknown' }
}

const nameOf = (room: DouyuFollowedRoom): string => room.roomName.trim() || `房间 ${room.room}`

export function Following({ data, onWatch }: {
  data: DouyuData
  /** Watch a room as the main commentary side. Extra-screen opening goes through IPC directly. */
  onWatch: (room: string) => void
}): React.ReactNode {
  const session = useSession()
  const account = data.active
  const accountId = account?.id ?? null
  const ready = !!account?.login.loggedIn
  const notify = useLiveNotices()

  // Per account: reopening shows the last list at once and reads it again quietly.
  const [list, setList] = useRemembered<DouyuFollowedRooms | null>(accountId ? `douyu:following:${accountId}` : null, null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notes, setNotes] = useState<Record<string, RowNote>>({})
  const [opening, setOpening] = useState<string[]>([])
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])

  // Notices raised while the tab is closed still reach the player's toast line.
  useEffect(() => { setNoticeSink((text) => session.notice('info', text)) }, [session])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const load = useCallback((): void => {
    const mine = ++generation.current
    if (!accountId || !ready) { setList(null); setLoading(false); return }
    setLoading(true)
    setError('')
    void apiClient.feature('getDouyuFollowedRooms', { accountId }).then((result) => {
      if (mine !== generation.current || !mounted.current) return
      setLoading(false)
      if (!result.ok) { setError(result.message); return }
      if (result.value.accountId !== accountId || !Array.isArray(result.value.rooms)) { setError('无法读取关注列表'); return }
      rememberRoomNames(result.value.rooms)
      setList(result.value)
      setNow(Date.now())
    })
  }, [accountId, ready])

  useEffect(() => {
    setNotes({})
    load()
  }, [load])

  // The main process stops a follow monitor when its account changes or signs out.
  useEffect(() => {
    if (!notify.enabled || !notify.accountId || notify.pending) return
    if (notify.accountId !== accountId || !ready) void stopForAccountChange()
  }, [notify.enabled, notify.accountId, notify.pending, accountId, ready])

  const send = (patch: { enabled?: boolean; scope?: NotifyScope; rooms?: string[] }): void => {
    const next = { enabled: notify.enabled, scope: notify.scope, rooms: notify.rooms, ...patch }
    if (!next.enabled && !notify.enabled) { draftLiveNotices({ scope: next.scope, rooms: next.rooms }); return }
    void applyLiveNotices({ ...next, accountId: ready ? accountId : null })
  }

  const toggle = (enabled: boolean): void => {
    if (enabled) {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission().catch(() => {})
      } catch { /* The in-app notice is enough. */ }
    }
    send({ enabled })
  }

  const pick = (room: string, on: boolean): void => {
    const rooms = on ? [...notify.rooms, room] : notify.rooms.filter((item) => item !== room)
    send({ rooms })
  }

  const openExtra = (room: DouyuFollowedRoom): void => {
    if (opening.includes(room.room)) return
    setOpening((items) => [...items, room.room])
    setNotes(({ [room.room]: _, ...rest }) => rest)
    void apiClient.feature('openStreamSession', { input: room.room, platform: 'douyu' }).then((result) => {
      if (!mounted.current) return
      setOpening((items) => items.filter((item) => item !== room.room))
      const note: RowNote = !result.ok ? { text: result.message, error: true }
        : result.value.phase === 'failed' ? { text: result.value.error ?? '同屏打开失败', error: true }
          : { text: '已在同屏打开', error: false }
      setNotes((items) => ({ ...items, [room.room]: note }))
    })
  }

  const rooms = list?.rooms ?? []
  const selectedFull = notify.rooms.length >= MAX_NOTIFY_ROOMS
  const needsAccount = notify.scope === 'all' && !ready

  return (
    <div className="desk-pane following">
      <section className="follow-notify" aria-label="开播提醒">
        <Switch label="开播提醒" checked={notify.enabled} disabled={notify.pending || (!notify.enabled && needsAccount)}
          detail="仅在应用运行期间检查；首次读取到的直播状态不视为开播" onChange={toggle} />
        <div className="row-split">
          <span className="muted">提醒范围</span>
          <Segmented label="提醒范围" value={notify.scope} options={SCOPES} disabled={notify.pending}
            onChange={(scope) => send({ scope })} />
        </div>
        <NotifyStatus ready={ready} />
      </section>

      {notify.notices.length > 0 && (
        <ul className="follow-notices" aria-label="开播通知">
          {notify.notices.map((notice) => (
            <li key={notice.id}>
              <span>{notice.text}</span>
              <span className="muted num">{formatTime(notice.at)}</span>
              <button type="button" className="btn-quiet small" onClick={() => onWatch(notice.room)}>作为解说观看</button>
              <button type="button" className="icon-btn" aria-label="移除通知" onClick={() => dismissLiveNotice(notice.id)}>
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row-split">
        <h3 className="follow-title">关注的直播间</h3>
        <button type="button" className="btn-quiet small" disabled={!ready || loading} onClick={load}>
          <Icon name="refresh" />刷新
        </button>
      </div>

      {!account && <p className="desk-empty">未设置当前账号，无法读取关注列表。</p>}
      {account && !ready && <p className="desk-empty">当前账号未登录，无法读取关注列表。</p>}
      {loading && <p className="lane" role="status">{list ? '正在更新关注列表' : '正在读取关注列表'}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {list && (
        <p className={list.coverage === 'all-pages' ? 'lane' : 'follow-partial'}>
          {list.coverage === 'all-pages'
            ? `共 ${rooms.length} 个房间，已读取全部 ${list.pageCount} 页。`
            : `仅读取到部分关注列表（${list.pageCount} 页，${rooms.length} 个房间）。${list.reason ?? ''}`}
          {' '}更新于 {formatTime(list.checkedAt)}
        </p>
      )}
      {list && rooms.length === 0 && <p className="desk-empty">关注列表为空。</p>}

      {rooms.length > 0 && (
        <ul className="follow-list" aria-label="关注的直播间">
          {rooms.map((room) => {
            const state = stateOf(room)
            const chosen = notify.rooms.includes(room.room)
            const note = notes[room.room]
            return (
              <li key={room.room} className="follow-row" role="group" aria-label={`${nameOf(room)} ${room.room}`}>
                <div className="follow-main">
                  <div className="follow-head">
                    <span className="follow-name">{nameOf(room)}</span>
                    <span className="follow-state" data-tone={state.tone}>{state.label}</span>
                  </div>
                  <span className="muted">{room.nickname ? `${room.nickname} · ` : ''}房间 <span className="num">{room.room}</span></span>
                  {isLive(room) && (
                    <span className="muted">
                      {room.startedAt === null
                        ? '开播时间未知 · 已播时长未知'
                        : `开播于 ${formatTime(room.startedAt)} · 已播 ${formatDuration((now - room.startedAt) / 1000)}`}
                    </span>
                  )}
                  {note && <span className={note.error ? 'form-error' : 'lane'} role={note.error ? 'alert' : 'status'}>{note.text}</span>}
                </div>
                <div className="follow-actions">
                  {notify.scope === 'selected' && (
                    <label className="follow-pick">
                      <input type="checkbox" checked={chosen} disabled={notify.pending || (!chosen && selectedFull)}
                        aria-label={`开播提醒 房间 ${room.room}`} onChange={(event) => pick(room.room, event.target.checked)} />
                      提醒
                    </label>
                  )}
                  <button type="button" className="btn-quiet small" onClick={() => onWatch(room.room)}>作为解说观看</button>
                  <button type="button" className="btn-quiet small" disabled={opening.includes(room.room)} onClick={() => openExtra(room)}>
                    {opening.includes(room.room) ? '正在打开' : '同屏观看'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function NotifyStatus({ ready }: { ready: boolean }): React.ReactNode {
  const notify = useLiveNotices()
  if (notify.pending) return <p className="lane" role="status">正在更新提醒设置</p>
  return (
    <>
      {notify.error && <p className="form-error" role="alert">{notify.error}</p>}
      {notify.monitorError && <p className="form-error" role="alert">监控状态：{notify.monitorError}</p>}
      {notify.stopped && <p className="lane" role="status">{notify.stopped}</p>}
      {notify.scope === 'all' && !ready && <p className="lane">全部关注需要已登录的当前账号。</p>}
      {notify.enabled && notify.scope === 'selected' && notify.rooms.length === 0 && (
        <p className="lane">请在下方列表中选择需要提醒的房间。</p>
      )}
      {notify.enabled && notify.scope === 'selected' && notify.rooms.length > 0 && (
        <p className="lane" role="status">已对所选 {notify.rooms.length} 个房间开启提醒。</p>
      )}
      {notify.enabled && notify.scope === 'all' && notify.accountId && (
        <p className="lane" role="status">已对当前账号的全部关注开启提醒，每 60 秒检查一次。</p>
      )}
    </>
  )
}
