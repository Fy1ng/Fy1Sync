import { useEffect, useRef, useState } from 'react'
import type { PlaylistView } from '../../server/m3uPlaylist'

export function PlaylistPicker({ entries, roleLabel, onSelect, onCancel }: {
  entries: PlaylistView['entries']; roleLabel: string; onSelect: (input: string) => Promise<void>; onCancel: () => void
}): React.ReactNode {
  const [search, setSearch] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  const channels = entries.filter(entry => `${entry.group} ${entry.name}`.toLowerCase().includes(search.toLowerCase()))
  return <dialog ref={dialog} aria-label="选择播放频道" onCancel={onCancel}
    style={{ width: 'min(640px, 90vw)', maxHeight: '80vh', padding: 24, borderRadius: 16, background: '#18202b', color: '#fff', border: '1px solid #536174' }}>
    <h2>选择频道 · 添加到{roleLabel}</h2>
    <input autoFocus aria-label="搜索频道或分组" placeholder="搜索频道或分组" value={search} onChange={event => setSearch(event.target.value)} />
    <p>{channels.length} / {entries.length} 个频道</p>
    <div style={{ maxHeight: '50vh', overflow: 'auto', display: 'grid', gap: 8 }}>
      {channels.map(entry => <button key={entry.input} type="button" className="btn-glass" onClick={() => void onSelect(entry.input)}>
        {entry.group && <small>{entry.group} · </small>}{entry.name}
      </button>)}
      {!channels.length && <p>没有匹配的频道</p>}
    </div>
    <button type="button" className="btn-quiet" onClick={onCancel}>取消</button>
  </dialog>
}
