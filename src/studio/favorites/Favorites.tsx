import { useState } from 'react'
import { Sheet, Icon } from '../kit'
import { useSession } from '../../app/SessionContext'
import { PLATFORM_LABEL, ROLE_LABEL, useSourceLoader, type RoomPlatform } from '../sources'
import { addSavedRoom, refreshSavedRooms, removeSavedRoom, useSavedRooms, type SavedRoom } from '../savedRooms'
import type { PlatformId, SourceRole } from '../../core/types'
import { savedRoomInput } from '../../core/savedRoomIdentity'
import './favorites.css'

const PLATFORMS = ['douyu', 'bilibili', 'huya', 'douyin', 'twitch', 'youtube'] as const
type FavoritePlatform = typeof PLATFORMS[number]
const STATUS = { live: '直播中', offline: '未开播', replay: '回放中', unknown: '状态未知' }
const time = (value: number): string => new Date(value).toLocaleString('zh-CN', { hour12: false })

export function RoomSummary({ room }: { room: SavedRoom }): React.ReactNode {
  const metadata = room.metadata
  const status = metadata?.status ?? 'unknown'
  return <span className="favorite-summary">
    {metadata?.avatarUrl ? <img className="favorite-avatar" src={metadata.avatarUrl} alt="" loading="lazy" onLoad={event => { event.currentTarget.style.visibility = '' }} onError={event => { event.currentTarget.style.visibility = 'hidden' }} />
      : <span className="favorite-avatar favorite-placeholder" aria-hidden="true">{(metadata?.nickname || room.label).slice(0, 1)}</span>}
    <span className="favorite-copy">
      <span className="favorite-name">{metadata?.nickname || room.label} <small>{PLATFORM_LABEL[room.platform as PlatformId] ?? room.platform}</small></span>
      <span className="favorite-title">{metadata?.title || room.label}</span>
      <span className="favorite-facts"><span className={`favorite-status is-${status}`}>{STATUS[status]}</span>
        {room.refreshError && <span>上次采集缓存</span>}</span>
      <span className="favorite-facts">{metadata?.lastStartedAt != null
        ? `${metadata.startTimeSource === 'observed' ? '本地检测开播' : '最近开播'}: ${time(metadata.lastStartedAt)}` : '最近开播: 未知'}</span>
      <span className="favorite-facts">{metadata ? `采集于 ${time(metadata.collectedAt)}` : '尚未成功采集'}</span>
    </span>
  </span>
}

export function Favorites({ onClose }: { onClose: () => void }): React.ReactNode {
  const rooms = useSavedRooms()
  const loader = useSourceLoader()
  const session = useSession()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [platform, setPlatform] = useState<FavoritePlatform>('douyu')
  const [input, setInput] = useState('')
  const [role, setRole] = useState<SourceRole>('official')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const run = async (key: string, operation: () => Promise<string | null>): Promise<void> => {
    setWorking(previous => new Set(previous).add(key))
    setError(null)
    try { const problem = await operation(); if (problem) setError(problem) }
    catch { setError('操作失败, 请稍后重试.') }
    finally { setWorking(previous => { const next = new Set(previous); next.delete(key); return next }) }
  }
  const watch = async (room: SavedRoom, target: SourceRole): Promise<void> => {
    const source = savedRoomInput(room.platform, room.metadata?.url ?? room.input)
    const ok = await loader.loadInput(target, source, ['douyu', 'bilibili', 'huya', 'douyin'].includes(room.platform) ? room.platform as RoomPlatform : undefined)
    if (ok) onClose()
    else {
      const message = '直播间加载失败, 请检查开播状态或登录信息后重试.'
      setError(message)
      session.notice('warn', message)
    }
  }
  const search = query.trim().toLocaleLowerCase()
  const filtered = (rooms ?? []).filter(room => (filter === 'all' || room.platform === filter)
    && [room.label, room.input, room.metadata?.nickname, room.metadata?.title, room.metadata?.roomId].some(value => value?.toLocaleLowerCase().includes(search)))

  return <Sheet title="收藏直播间" onClose={onClose} wide>
    <div className="favorites-body">
      <p className="muted">自动检测开播状态. 上次成功采集的信息会一直保留, 直到下一次成功采集更新.</p>
      <form className="favorites-add" aria-label="收藏新直播间" onSubmit={event => {
        event.preventDefault()
        void run('add', async () => {
          const problem = await addSavedRoom({ role, platform, input: input.trim(), label: input.trim().slice(0, 100) })
          if (!problem) setInput('')
          return problem
        })
      }}>
        <label>平台<select aria-label="收藏平台" value={platform} onChange={event => setPlatform(event.target.value as FavoritePlatform)}>
          {PLATFORMS.map(value => <option key={value} value={value}>{PLATFORM_LABEL[value]}</option>)}
        </select></label>
        <label className="favorites-input">直播间<input aria-label="收藏直播间链接或房间号" value={input} maxLength={500} onChange={event => setInput(event.target.value)}
          placeholder={platform === 'youtube' ? 'YouTube 频道或直播链接, 视频 ID' : '直播间链接或房间号'} spellCheck={false} /></label>
        <label>默认载入<select aria-label="收藏默认载入位置" value={role} onChange={event => setRole(event.target.value as SourceRole)}>
          <option value="official">画面</option><option value="commentary">解说</option>
        </select></label>
        <button type="submit" className="btn-solid" disabled={!input.trim() || working.has('add')}>{working.has('add') ? '收藏中' : '收藏房间'}</button>
      </form>
      <div className="favorites-tools">
        <select aria-label="筛选收藏平台" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部平台</option>
          {PLATFORMS.map(value => <option key={value} value={value}>{PLATFORM_LABEL[value]}</option>)}
        </select>
        <input aria-label="搜索收藏直播间" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索主播, 标题或房间号" />
        <button type="button" className="btn-quiet" disabled={!rooms?.length || working.size > 0} onClick={() => void run('all', () => refreshSavedRooms())}>
          <Icon name="refresh" />{working.has('all') ? '采集中' : '全部刷新'}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {rooms === null ? <p role="status">正在读取收藏...</p> : !filtered.length ? <p className="favorites-empty">{rooms.length ? '没有匹配的收藏直播间.' : '还没有收藏. 未开播的直播间也可以收藏.'}</p> :
        <ul className="favorites-list" aria-label="收藏直播间列表">{filtered.map(room => <li key={room.id} className="favorite-card">
          <RoomSummary room={room} />
          {room.refreshError && <p className="favorite-warning" role="status">{room.refreshError}</p>}
          <div className="favorite-actions"><span className="favorite-role" aria-label={`默认载入${ROLE_LABEL[room.role]}`}>{ROLE_LABEL[room.role]}</span>
            <button type="button" className="btn-quiet small" disabled={working.has(room.id) || working.has('all')} onClick={() => void run(room.id, () => refreshSavedRooms(room.id))}>{working.has(room.id) ? '处理中' : '刷新'}</button>
            <button type="button" className="btn-quiet small is-danger" disabled={working.has(room.id) || working.has('all')} onClick={() => void run(room.id, () => removeSavedRoom(room.id))}>取消收藏</button>
            <button type="button" className="btn-glass small" disabled={loader.state.official.busy} onClick={() => void watch(room, 'official')}>载入画面</button>
            <button type="button" className="btn-glass small" disabled={loader.state.commentary.busy} onClick={() => void watch(room, 'commentary')}>载入解说</button>
          </div>
        </li>)}</ul>}
      <p className="muted">应用运行期间自动检测, 采集失败保留旧信息. 手动刷新间隔至少 15 秒.</p>
    </div>
  </Sheet>
}
