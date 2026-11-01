import { useState } from 'react'
import type { HudSize, HudStylePack, HudVariant } from '../../core/hudStylePack'

export function LayoutSection({ pack, variant, canCreate, frameSize, onSelect, onCreate, onGenerate, onRename, onDelete }: {
  pack: HudStylePack; variant: HudVariant; canCreate: boolean; onSelect: (id: string) => void; onCreate: () => void
  frameSize?: HudSize
  onGenerate: (height: 1440 | 1080) => void; onRename: (id: string) => string | null; onDelete: () => void
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
    <p className="muted" data-testid="layout-reference-size">参考尺寸 {variant.nativeSize.width}x{variant.nativeSize.height}, 不限制录像分辨率. 区域像素与预览字框以参考尺寸为准.</p>
    {frameSize && frameSize.width > 0 && frameSize.height > 0 && (frameSize.width !== variant.nativeSize.width || frameSize.height !== variant.nativeSize.height)
      && <p className="muted" data-testid="layout-scaled-frame">当前画面 {frameSize.width}x{frameSize.height}, 已按比例适配. 裁剪, 黑边或 HUD 位置变化仍需另设布局.</p>}
    <form className="layout-id-row" onSubmit={event => { event.preventDefault(); setError(onRename(id)) }}>
      <input className="text-input num" aria-label="布局 ID" spellCheck={false} value={id} onChange={event => { setId(event.target.value); setError(null) }} />
      <button type="submit" className="btn-quiet small" disabled={id === variant.id}>改名</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="layout-actions">
      <button type="button" className="btn-quiet small" disabled={!canCreate} onClick={onCreate}>新建布局</button>
      <button type="button" className="btn-quiet small is-danger" disabled={pack.variants.length <= 1} onClick={onDelete}>删除布局</button>
    </div>
    {variant.nativeSize.width === 3840 && variant.nativeSize.height === 2160 && <div className="layout-actions">
      <button type="button" className="btn-quiet small" onClick={() => onGenerate(1440)}>生成 1440p</button>
      <button type="button" className="btn-quiet small" onClick={() => onGenerate(1080)}>生成 1080p</button>
    </div>}
    {pack.variants.length > 1 && <p className="muted">优先匹配同参考尺寸的布局, 否则尝试其他布局; 多个候选需要主办方模板区分.</p>}
    {multiple && (!variant.organizer || !variant.organizer.enabled) && <p className="note-warn" data-testid="layout-organizer-warning">同一尺寸有多个布局, 当前布局的主办方未启用, 不会自动选中.</p>}
  </section>
}
