import { useState } from 'react'
import { Sheet, Icon } from '../kit'
import { useSession } from '../../app/SessionContext'
import { EMPTY_DIRECT_DRAFT, hasDirectOptions, parseDirectDraft, type DirectStreamDraft } from '../../core/directStream'
import { parseSourceInput } from '../../core/mediaSources'
import { PLATFORM_LABEL, ROLE_LABEL, useSourceLoader, type RoomPlatform } from '../sources'
import { addSavedRoom, refreshSavedRooms, removeSavedRoom, useSavedRoomsState, type SavedRoom } from '../savedRooms'
import type { PlatformId, SourceRole } from '../../core/types'
import { savedRoomInput } from '../../core/savedRoomIdentity'
import { DirectStreamFields } from '../DirectStreamFields'
import { ReadError } from '../ReadError'
import './favorites.css'

const PLATFORMS = ['douyu', 'bilibili', 'huya', 'douyin', 'twitch', 'youtube', 'direct'] as const
type FavoritePlatform = typeof PLATFORMS[number]
const STATUS = { live: '直播中', offline: '未开播', replay: '回放中', unknown: '状态未知' }
const time = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false })

function RoomTimes({ room }: { room: SavedRoom }): React.ReactNode {
  if (room.platform === 'direct') {
    const headerCount = Object.keys(room.headers ?? {}).length
    return <span className="favorite-times">
      {headerCount > 0 && <span className="favorite-facts">附带 {headerCount} 项请求头</span>}
      <span className="favorite-facts">纯直播流直链</span>
    </span>
  }
  const metadata = room.metadata
  return <span className="favorite-times">
    {metadata?.lastStartedAt != null && <span className="favorite-facts">{`${metadata.startTimeSource === 'observed' ? '首次检测到直播' : '最近开播'}：${time(metadata.lastStartedAt)}`}</span>}
    <span className="favorite-facts">{metadata ? `更新于 ${time(metadata.collectedAt)}` : '直播状态待获取'}</span>
  </span>
}

export function RoomSummary({ room, showTimes = true }: { room: SavedRoom; showTimes?: boolean }): React.ReactNode {
  const isDirect = room.platform === 'direct'
  const metadata = room.metadata
  const status = metadata?.status ?? 'unknown'
  return <span className="favorite-summary">
    {metadata?.avatarUrl ? <img className="favorite-avatar" src={metadata.avatarUrl} alt="" loading="lazy" onLoad={event => { event.currentTarget.style.visibility = '' }} onError={event => { event.currentTarget.style.visibility = 'hidden' }} />
      : <span className="favorite-avatar favorite-placeholder" aria-hidden="true">{(metadata?.nickname || room.label).slice(0, 1)}</span>}
    <span className="favorite-copy">
      <span className="favorite-name">{metadata?.nickname || room.label} <small>{PLATFORM_LABEL[room.platform as PlatformId] ?? '其他平台'}</small></span>
      <span className="favorite-title">{isDirect ? room.input : (metadata?.title || room.label)}</span>
      <span className="favorite-facts">
        <span className={`favorite-status ${isDirect ? '' : `is-${status}`}`.trim()}>
          {isDirect ? '直链片源' : room.refreshError && metadata ? `上次更新时${STATUS[status]}` : STATUS[status]}
        </span>
      </span>
      {showTimes && <RoomTimes room={room} />}
    </span>
  </span>
}

export function Favorites({ onClose }: { onClose: () => void }): React.ReactNode {
  const { rooms, error: loadError, loading, retry } = useSavedRoomsState()
  const loader = useSourceLoader()
  const session = useSession()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [platform, setPlatform] = useState<FavoritePlatform>('douyu')
  const [input, setInput] = useState('')
  const [role, setRole] = useState<SourceRole>('official')
  const [directDraft, setDirectDraft] = useState<DirectStreamDraft>({ ...EMPTY_DIRECT_DRAFT })
  const [directOpen, setDirectOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const run = async (key: string, operation: () => Promise<string | null>): Promise<void> => {
    setWorking(previous => new Set(previous).add(key))
    setError(null)
    try { const problem = await operation(); if (problem) setError(problem) }
    catch { setError('操作失败，请稍后重试') }
    finally { setWorking(previous => { const next = new Set(previous); next.delete(key); return next }) }
  }
  const watch = async (room: SavedRoom, target: SourceRole): Promise<void> => {
    const source = savedRoomInput(room.platform, room.metadata?.url ?? room.input)
    const directOptions = room.platform === 'direct'
      ? { ...(room.label ? { label: room.label } : {}), ...(room.headers ? { headers: room.headers } : {}) }
      : undefined
    const ok = await loader.loadInput(
      target,
      source,
      ['douyu', 'bilibili', 'huya', 'douyin'].includes(room.platform) ? room.platform as RoomPlatform : undefined,
      ...(hasDirectOptions(directOptions) ? [directOptions] : []),
    )
    if (ok) onClose()
    else {
      const message = room.platform === 'direct' ? '直播流载入失败，请检查流地址或请求头后重试' : '直播间载入失败，请检查开播状态或登录信息后重试'
      setError(message)
      session.notice('warn', message)
    }
  }
  const search = query.trim().toLocaleLowerCase()
  const filtered = (rooms ?? []).filter(room => (filter === 'all' || room.platform === filter)
    && [room.label, room.input, room.metadata?.nickname, room.metadata?.title, room.metadata?.roomId].some(value => value?.toLocaleLowerCase().includes(search)))

  return <Sheet title="收藏直播间" onClose={onClose} wide>
    <div className="favorites-body">
      <form className="favorites-add" aria-label="收藏新直播间" onSubmit={event => {
        event.preventDefault()
        void run('add', async () => {
          const trimmed = input.trim()
          if (platform === 'direct') {
            const parsedDirect = parseDirectDraft(directDraft)
            if (!parsedDirect.ok) {
              setDirectOpen(true)
              return parsedDirect.message
            }
            const parsedSource = parseSourceInput(trimmed)
            const fallbackLabel = parsedSource.ok ? parsedSource.label : trimmed.slice(0, 100)
            const label = (parsedDirect.options?.label ?? fallbackLabel).slice(0, 100)
            const problem = await addSavedRoom({
              role,
              platform,
              input: trimmed,
              label,
              ...(parsedDirect.options?.headers ? { headers: parsedDirect.options.headers } : {}),
            })
            if (!problem) {
              setInput('')
              setDirectDraft({ ...EMPTY_DIRECT_DRAFT })
              setDirectOpen(false)
            }
            return problem
          }
          const problem = await addSavedRoom({ role, platform, input: trimmed, label: trimmed.slice(0, 100) })
          if (!problem) setInput('')
          return problem
        })
      }}>
        <label>平台<select aria-label="收藏平台" value={platform} onChange={event => { setPlatform(event.target.value as FavoritePlatform); setError(null) }}>
          {PLATFORMS.map(value => <option key={value} value={value}>{PLATFORM_LABEL[value]}</option>)}
        </select></label>
        <label className="favorites-input">{platform === 'direct' ? '直播流地址' : '直播间'}<input aria-label="收藏直播间链接或房间号" value={input} maxLength={platform === 'direct' ? 4096 : 500} onChange={event => setInput(event.target.value)}
          placeholder={platform === 'youtube' ? 'YouTube 频道或直播链接，视频 ID' : platform === 'direct' ? 'm3u8、flv、ts 等 HTTP/HTTPS 直播流地址' : '直播间链接或房间号'} spellCheck={false} /></label>
        <label>默认载入<select aria-label="收藏默认载入位置" value={role} onChange={event => setRole(event.target.value as SourceRole)}>
          <option value="official">画面</option><option value="commentary">解说</option>
        </select></label>
        <button type="submit" className="btn-solid" disabled={!input.trim() || working.has('add')}>{working.has('add') ? '收藏中' : '收藏房间'}</button>
        {platform === 'direct' && (
          <div className="favorites-direct">
            <DirectStreamFields
              input={input}
              draft={directDraft}
              open={directOpen}
              disabled={working.has('add')}
              onToggle={() => setDirectOpen(open => !open)}
              onChange={next => { setDirectDraft(next); setError(null) }}
            />
          </div>
        )}
      </form>
      <div className="favorites-tools">
        <select aria-label="筛选收藏平台" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部平台</option>
          {PLATFORMS.map(value => <option key={value} value={value}>{PLATFORM_LABEL[value]}</option>)}
        </select>
        <input aria-label="搜索收藏直播间" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索主播，标题或房间号" />
        <button type="button" className="btn-quiet" disabled={!rooms?.some(item => item.platform !== 'direct') || working.size > 0} onClick={() => void run('all', () => refreshSavedRooms())}>
          <Icon name="refresh" />{working.has('all') ? '刷新中' : '全部刷新'}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loadError && <ReadError error={loadError} onRetry={retry} />}
      {rooms === null ? (loading && <p role="status">正在读取收藏</p>) : !filtered.length ? (!loadError && !loading && <p className="favorites-empty">{rooms.length ? '没有匹配的收藏直播间' : '还没有收藏，未开播的房间也能添加'}</p>) :
        <ul className="favorites-list" aria-label="收藏直播间列表">{filtered.map(room => <li key={room.id} className="favorite-card">
          <RoomSummary room={room} showTimes={false} />
          <RoomTimes room={room} />
          {room.refreshError && <p className="favorite-warning" role="status">{room.refreshError}</p>}
          <div className="favorite-actions"><span className="favorite-role" aria-label={`默认载入${ROLE_LABEL[room.role]}`}>{ROLE_LABEL[room.role]}</span>
            <div className="favorite-buttons">
              {room.platform !== 'direct' && (
                <button type="button" className="btn-quiet small" disabled={working.has(room.id) || working.has('all')} onClick={() => void run(room.id, () => refreshSavedRooms(room.id))}>{working.has(room.id) ? '处理中' : '刷新'}</button>
              )}
              <button type="button" className="btn-quiet small is-danger" disabled={working.has(room.id) || working.has('all')} onClick={() => void run(room.id, () => removeSavedRoom(room.id))}>取消收藏</button>
              <button type="button" className="btn-glass small" disabled={loader.state.official.busy} onClick={() => void watch(room, 'official')}>载入画面</button>
              <button type="button" className="btn-glass small" disabled={loader.state.commentary.busy} onClick={() => void watch(room, 'commentary')}>载入解说</button>
            </div>
          </div>
        </li>)}</ul>}
    </div>
  </Sheet>
}
