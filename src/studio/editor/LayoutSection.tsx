import { useState } from 'react'
import type { HudStylePack, HudVariant } from '../../core/hudStylePack'

export function LayoutSection({ pack, variant, canCreate, onSelect, onCreate, onRename, onDelete }: {
  pack: HudStylePack; variant: HudVariant; canCreate: boolean; onSelect: (id: string) => void; onCreate: () => void
  onRename: (id: string) => string | null; onDelete: () => void
}): React.ReactNode {
  const [id, setId] = useState(variant.id)
  const [error, setError] = useState<string | null>(null)
  const multiple = pack.variants.filter(item => item.nativeSize.width === variant.nativeSize.width
    && item.nativeSize.height === variant.nativeSize.height).length > 1
  return <section className="rail-group layout-section" aria-label="布局管理">
    <label className="field-stack"><span className="field-label">当前布局</span>
      <select className="text-input num" aria-label="当前布局" value={variant.id} onChange={event => onSelect(event.target.value)}>
        {pack.variants.map(item => <option key={item.id} value={item.id}>{item.id} ({item.nativeSize.width}x{item.nativeSize.height})</option>)}
      </select>
    </label>
    <form className="layout-id-row" onSubmit={event => { event.preventDefault(); setError(onRename(id)) }}>
      <input className="text-input num" aria-label="布局 ID" spellCheck={false} value={id} onChange={event => { setId(event.target.value); setError(null) }} />
      <button type="submit" className="btn-quiet small" disabled={id === variant.id}>改名</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="layout-actions">
      <button type="button" className="btn-quiet small" disabled={!canCreate} onClick={onCreate}>新建布局</button>
      <button type="button" className="btn-quiet small is-danger" disabled={pack.variants.length <= 1} onClick={onDelete}>删除布局</button>
    </div>
    {multiple && !variant.organizer && <p className="note-warn" data-testid="layout-organizer-warning">同一尺寸有多个布局, 当前布局没有主办方区域, 这个布局不会被播放器选中.</p>}
  </section>
}
