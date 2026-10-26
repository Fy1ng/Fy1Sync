/**
 * Local danmaku history search and favorites (handoff items 32, 35).
 *
 * History is the in-memory record of what this app received while it ran (`received-only`);
 * it is not a complete archive. The Doseeing button opens a third-party public page and only
 * runs on an explicit click. Favorites are the only danmaku kept on disk; "填入发送框" puts
 * the text into the composer and never sends it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { MessageHistoryPage, MessageHistoryQuery } from '../../../server/danmaku/messageHistory'
import type { FavoriteDanmaku, FavoriteDanmakuPage } from '../../../electron/danmakuFeatures'
import { Sheet, SideTabs } from '../kit'
import './records.css'

export type RecordsTab = 'history' | 'favorites'

const PAGE_SIZE = 50

const ROOM = /^[1-9][0-9]{0,11}$/
const UID = /^[1-9][0-9]{0,19}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/

type Filters = { uid: string; room: string; text: string }

/** Turns the typed filters into a query the main process accepts, or names the bad field. */
function toQuery(filters: Filters, page: number): MessageHistoryQuery | string {
  const uid = filters.uid.trim(), room = filters.room.trim(), text = filters.text.trim()
  if (uid && !UID.test(uid)) return '用户 ID 须为数字'
  if (room && !ROOM.test(room)) return '房间号须为数字'
  if (text.length > 200 || CONTROL.test(text)) return '搜索内容过长或含有无效字符'
  return { ...(uid ? { uid } : {}), ...(room ? { room } : {}), query: text, page, pageSize: PAGE_SIZE }
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const time = date.toLocaleTimeString('zh-CN', { hour12: false })
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString('zh-CN')} ${time}`
}

/** Latest-request-wins loader: a slow earlier page never overwrites a newer one. */
function usePagedQuery<T>(load: (query: MessageHistoryQuery) => Promise<{ ok: true; value: T } | { ok: false; message: string }>) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  useEffect(() => () => { sequence.current += 1 }, [])
  const run = useCallback(async (query: MessageHistoryQuery): Promise<void> => {
    const ticket = ++sequence.current
    setLoading(true)
    setError('')
    const result = await load(query)
    if (ticket !== sequence.current) return
    setLoading(false)
    if (result.ok) setData(result.value)
    else setError(result.message)
  }, [load])
  return { data, loading, error, setError, run }
}

function Pager({ page, total, hasMore, loading, onPage }: {
  page: number
  total: number
  hasMore: boolean
  loading: boolean
  onPage: (page: number) => void
}): React.ReactNode {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <div className="records-pager">
      <span className="muted">共 <span className="num">{total}</span> 条 · 第 <span className="num">{page}</span>/<span className="num">{pages}</span> 页</span>
      <span className="row-end">
        <button type="button" className="btn-quiet small" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
        <button type="button" className="btn-quiet small" disabled={loading || !hasMore} onClick={() => onPage(page + 1)}>下一页</button>
      </span>
    </div>
  )
}

const queryHistory = (query: MessageHistoryQuery) => apiClient.feature('queryDanmakuHistory', query)
const queryFavorites = (query: MessageHistoryQuery) => apiClient.feature('queryDanmakuFavorites', query)

function HistoryTab({ initialUid, room }: { initialUid?: string; room: string | null }): React.ReactNode {
  const [filters, setFilters] = useState<Filters>({ uid: initialUid ?? '', room: room ?? '', text: '' })
  const [applied, setApplied] = useState<Filters>(filters)
  const [page, setPage] = useState(1)
  const { data, loading, error, setError, run } = usePagedQuery<MessageHistoryPage>(queryHistory)
  const [external, setExternal] = useState('')

  useEffect(() => {
    const query = toQuery(applied, page)
    if (typeof query === 'string') { setError(query); return }
    void run(query)
  }, [applied, page, run, setError])

  const search = (event: React.FormEvent): void => {
    event.preventDefault()
    const query = toQuery(filters, 1)
    if (typeof query === 'string') { setError(query); return }
    setApplied({ ...filters })
    setPage(1)
  }

  const uid = filters.uid.trim()
  const openExternal = async (): Promise<void> => {
    setExternal('')
    const result = await apiClient.feature('openDanmakuHistory', { uid })
    if (!result.ok) setExternal(result.message)
  }

  const set = (key: keyof Filters) => (event: React.ChangeEvent<HTMLInputElement>): void => {
    setFilters((value) => ({ ...value, [key]: event.target.value }))
  }

  return (
    <div className="records-pane">
      <form className="records-filters" onSubmit={search} role="search" aria-label="搜索历史弹幕">
        <input className="text-input num" value={filters.uid} onChange={set('uid')} placeholder="用户 ID" aria-label="用户 ID" inputMode="numeric" />
        <input className="text-input num" value={filters.room} onChange={set('room')} placeholder="房间号" aria-label="房间号" inputMode="numeric" />
        <input className="text-input" type="search" value={filters.text} onChange={set('text')} placeholder="弹幕内容" aria-label="弹幕内容" />
        <button type="submit" className="btn-solid small" disabled={loading}>搜索</button>
      </form>
      <div className="row-split records-note">
        <p className="muted">仅包含本应用运行期间接收到的弹幕，不是完整历史记录。</p>
        {UID.test(uid) && (
          <button type="button" className="btn-quiet small" onClick={() => void openExternal()} title="在浏览器中打开第三方公开页面">
            在 Doseeing 查看<span className="records-third">第三方</span>
          </button>
        )}
      </div>
      {external && <p className="form-error" role="alert">{external}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {data?.truncated && <p className="muted">已超出本地容量 {data.capacity} 条，较早的记录已移除。</p>}
      {data && (data.items.length === 0
        ? <p className="records-empty">无匹配的弹幕</p>
        : (
          <ol className="records-list" aria-label="历史弹幕">
            {data.items.map((item) => (
              <li key={`${item.room}:${item.id}`} className="records-row">
                <div className="records-meta">
                  <time className="num" dateTime={new Date(item.receivedAt).toISOString()}>{formatTime(item.receivedAt)}</time>
                  <span className="records-user">{item.username || '匿名'}</span>
                  {item.sender?.uid && <span className="num muted">UID {item.sender.uid}</span>}
                  <span className="num muted">房间 {item.room}</span>
                </div>
                <p className="records-text">{item.text}</p>
              </li>
            ))}
          </ol>
        ))}
      {data && data.total > 0 && (
        <Pager page={data.page} total={data.total} hasMore={data.hasMore} loading={loading} onPage={setPage} />
      )}
    </div>
  )
}

function FavoriteRow({ item, onChanged, onRemoved, onFill }: {
  item: FavoriteDanmaku
  onChanged: (item: FavoriteDanmaku) => void
  onRemoved: () => void
  onFill: (text: string) => void
}): React.ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const save = async (): Promise<void> => {
    const text = draft.trim()
    if (!text) { setError('内容不能为空'); return }
    if (text.length > 2000 || CONTROL.test(text)) { setError('内容过长或含有无效字符'); return }
    if (text === item.text) { setEditing(false); return }
    setBusy(true)
    setError('')
    const result = await apiClient.feature('updateDanmakuFavorite', { id: item.id, text })
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) { setError(result.message); return }
    setEditing(false)
    onChanged(result.value)
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const result = await apiClient.feature('removeDanmakuFavorite', { id: item.id })
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) { setError(result.message); setConfirming(false); return }
    onRemoved()
  }

  return (
    <li className="records-row">
      <div className="records-meta">
        <time className="num" dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
        {item.username && <span className="records-user">{item.username}</span>}
        {item.uid && <span className="num muted">UID {item.uid}</span>}
        {item.room && <span className="num muted">房间 {item.room}</span>}
      </div>
      {editing ? (
        <textarea className="text-input records-edit" rows={2} value={draft} aria-label="编辑收藏内容"
          onChange={(event) => setDraft(event.target.value)} disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); setDraft(item.text) }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void save() }
          }} />
      ) : <p className="records-text">{item.text}</p>}
      <div className="row-end records-actions">
        {editing ? (
          <>
            <button type="button" className="btn-quiet small" disabled={busy} onClick={() => { setEditing(false); setDraft(item.text); setError('') }}>取消</button>
            <button type="button" className="btn-solid small" disabled={busy} onClick={() => void save()}>保存</button>
          </>
        ) : confirming ? (
          <>
            <span className="muted">确认删除此收藏？</span>
            <button type="button" className="btn-quiet small" disabled={busy} onClick={() => setConfirming(false)}>取消</button>
            <button type="button" className="btn-quiet small is-danger" disabled={busy} onClick={() => void remove()}>确认删除</button>
          </>
        ) : (
          <>
            <button type="button" className="btn-quiet small" onClick={() => { setDraft(item.text); setEditing(true) }}>编辑</button>
            <button type="button" className="btn-quiet small" onClick={() => setConfirming(true)}>删除</button>
            <button type="button" className="btn-solid small" onClick={() => onFill(item.text)}>填入发送框</button>
          </>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  )
}

function FavoritesTab({ onFill }: { onFill: (text: string) => void }): React.ReactNode {
  const [text, setText] = useState('')
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const { data, loading, error, setError, run } = usePagedQuery<FavoriteDanmakuPage>(queryFavorites)
  const [items, setItems] = useState<FavoriteDanmaku[]>([])

  useEffect(() => {
    const query = toQuery({ uid: '', room: '', text: applied }, page)
    if (typeof query === 'string') { setError(query); return }
    void run(query)
  }, [applied, page, revision, run, setError])
  useEffect(() => { if (data) setItems(data.items) }, [data])
  // Deleting the last row of a later page steps back instead of showing an empty page.
  useEffect(() => {
    if (data && data.items.length === 0 && data.page > 1 && data.total > 0) setPage(Math.ceil(data.total / PAGE_SIZE))
  }, [data])

  const search = (event: React.FormEvent): void => {
    event.preventDefault()
    const query = toQuery({ uid: '', room: '', text }, 1)
    if (typeof query === 'string') { setError(query); return }
    setApplied(text.trim())
    setPage(1)
    setRevision((value) => value + 1)
  }

  return (
    <div className="records-pane">
      <form className="records-filters is-single" onSubmit={search} role="search" aria-label="搜索收藏">
        <input className="text-input" type="search" value={text} onChange={(event) => setText(event.target.value)}
          placeholder="弹幕内容或用户名" aria-label="搜索收藏" />
        <button type="submit" className="btn-solid small" disabled={loading}>搜索</button>
      </form>
      <p className="muted">收藏保存在本机，填入发送框后需手动发送。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && (items.length === 0
        ? <p className="records-empty">{applied ? '无匹配的收藏' : '暂无收藏'}</p>
        : (
          <ol className="records-list" aria-label="收藏弹幕">
            {items.map((item) => (
              <FavoriteRow key={item.id} item={item} onFill={onFill}
                onChanged={(next) => setItems((list) => list.map((entry) => entry.id === next.id ? next : entry))}
                onRemoved={() => setRevision((value) => value + 1)} />
            ))}
          </ol>
        ))}
      {data && data.total > 0 && (
        <Pager page={data.page} total={data.total} hasMore={data.hasMore} loading={loading} onPage={setPage} />
      )}
    </div>
  )
}

const TABS: { id: RecordsTab; label: string }[] = [
  { id: 'history', label: '历史' },
  { id: 'favorites', label: '收藏' },
]

export function DanmakuRecordsSheet({ initialTab, initialUid, room, onClose, onFill }: {
  initialTab: RecordsTab
  /** Pre-filled UID filter for the history tab, from a chat row's "历史弹幕". */
  initialUid?: string
  /** The connected danmaku room, if any. */
  room: string | null
  onClose: () => void
  /** Put a favorite into the send box. Never sends. */
  onFill: (text: string) => void
}): React.ReactNode {
  return (
    <Sheet title="弹幕记录" onClose={onClose} wide>
      <DanmakuRecords initialTab={initialTab} initialUid={initialUid} room={room} onFill={onFill} />
    </Sheet>
  )
}

/** The 弹幕记录 section of 设置; the standalone sheet above wraps the same body. */
export function DanmakuRecords({ initialTab, initialUid, room, onFill }: {
  initialTab: RecordsTab
  initialUid?: string
  room: string | null
  onFill: (text: string) => void
}): React.ReactNode {
  const [tab, setTab] = useState<RecordsTab>(initialTab)
  // A chat row's 历史弹幕 can open this again for another user while it is showing.
  useEffect(() => setTab(initialTab), [initialTab, initialUid])
  // Both panes stay mounted so switching tabs keeps each one's filters and page.
  return (
    <SideTabs label="弹幕记录" value={tab} onChange={setTab} tabs={TABS}>
      <div className="records-content">
        <div hidden={tab !== 'history'}><HistoryTab key={initialUid ?? ''} initialUid={initialUid} room={room} /></div>
        <div hidden={tab !== 'favorites'}><FavoritesTab onFill={onFill} /></div>
      </div>
    </SideTabs>
  )
}
