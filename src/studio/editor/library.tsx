/**
 * The top bar's two menus. Opening a preset or draft and moving files in and out happen
 * once per session, so they stay out of the working area until asked for.
 */

import { useRef } from 'react'
import type { PresetSummary } from '../../app/apiClient'
import type { StoredProfile } from '../../core/profileStore'
import { Icon, Popover, usePopover } from '../kit'

export function LibraryMenu({ presets, drafts, onLoadPreset, onLoadDraft, onDeleteDraft }: {
  presets: PresetSummary[]
  drafts: StoredProfile[]
  onLoadPreset: (id: string) => Promise<void>
  onLoadDraft: (id: string) => Promise<void>
  onDeleteDraft: (id: string) => Promise<void>
}): React.ReactNode {
  const menu = usePopover()
  return (
    <div className="more">
      <button type="button" className="btn-quiet" onClick={menu.toggle} aria-expanded={menu.open}>
        打开<Icon name="chevron" />
      </button>
      <Popover open={menu.open} onClose={menu.close} className="editor-menu library-menu" label="打开">
        <p className="menu-heading">本机预设</p>
        {presets.length === 0 ? <p className="menu-meta menu-empty">暂无已发布的预设</p> : presets.map((preset) => (
          <button type="button" key={preset.id} className="menu-item library-item"
            onClick={() => { menu.close(); void onLoadPreset(preset.id) }}>
            <span className="library-name">{preset.name}</span>
            <span className="menu-note num">{preset.id} · {preset.templateChars} 个字符</span>
          </button>
        ))}
        <div className="menu-rule" />
        <p className="menu-heading">本机草稿</p>
        {drafts.length === 0 ? <p className="menu-meta menu-empty">暂无草稿</p> : drafts.map((draft) => (
          <div key={draft.id} className="library-row">
            <button type="button" className="menu-item library-item"
              onClick={() => { menu.close(); void onLoadDraft(draft.id) }}>
              <span className="library-name">{draft.profile.name}</span>
              <span className="menu-note num">{draft.id} · {new Date(draft.updatedAt).toLocaleString()}</span>
            </button>
            <button type="button" className="icon-btn library-delete" onClick={() => void onDeleteDraft(draft.id)}
              aria-label={`删除草稿 ${draft.id}`} title="删除草稿"><Icon name="close" /></button>
          </div>
        ))}
      </Popover>
    </div>
  )
}

export function FileMenu({ onNew, onImport, onExport }: {
  onNew: () => void
  onImport: (file: File) => Promise<void>
  onExport: () => void
}): React.ReactNode {
  const menu = usePopover()
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <div className="more">
      <button type="button" className="icon-btn" onClick={menu.toggle} aria-label="更多" aria-expanded={menu.open}>
        <Icon name="more" />
      </button>
      {/* Outside the popover so the picker survives the menu closing behind it. */}
      <input ref={input} type="file" accept="application/json,.json" hidden aria-label="导入 JSON"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void onImport(file)
          event.target.value = ''
        }} />
      <Popover open={menu.open} onClose={menu.close} className="editor-menu file-menu" label="更多">
        <button type="button" className="menu-item" onClick={() => { menu.close(); onNew() }}>新建空白样式</button>
        <button type="button" className="menu-item" onClick={() => { menu.close(); input.current?.click() }}>导入 JSON</button>
        <button type="button" className="menu-item" onClick={() => { menu.close(); onExport() }}>导出 JSON</button>
      </Popover>
    </div>
  )
}
