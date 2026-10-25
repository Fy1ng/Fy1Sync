/**
 * How danmaku look over the picture, and which ones never show. Every change applies live
 * to the running layer, so there is no save button: the picture behind is the preview.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { Icon, Segmented, Switch } from './kit'

export function DanmakuPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const danmaku = settings.danmaku
  const set = session.updateDanmakuSettings.bind(session)
  const invalid = new Map(session.invalidPatterns.map((entry) => [entry.source, entry.message]))

  return (
    <aside className="float-panel" aria-label="弹幕设置"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <header className="float-head">
        <h2>弹幕</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭弹幕设置"><Icon name="close" /></button>
      </header>
      <div className="float-body">
        <Switch label="显示弹幕" checked={danmaku.enabled} onChange={(enabled) => set({ enabled })} />
        <Switch label="显示礼物消息" detail="在弹幕列表中显示观众赠送的礼物" checked={danmaku.showGifts}
          onChange={(showGifts) => set({ showGifts })} />

        <Range label="字号" value={danmaku.fontSize} min={14} max={48} step={1} unit="px" onChange={(fontSize) => set({ fontSize })} />
        <Range label="速度" value={danmaku.speed} min={60} max={360} step={10} unit="" format={(v) => v < 130 ? '慢' : v > 220 ? '快' : '中'}
          onChange={(speed) => set({ speed })} />
        <Range label="透明度" value={Math.round((1 - danmaku.opacity) * 100)} min={0} max={80} step={5} unit="%"
          onChange={(value) => set({ opacity: 1 - value / 100 })} />
        <Range label="密度" value={Math.round(danmaku.density * 100)} min={10} max={100} step={10} unit="%"
          onChange={(value) => set({ density: value / 100 })} />
        <div className="field-stack">
          <span className="field-label">占用画面</span>
          <Segmented label="占用画面" value={danmaku.area} onChange={(area) => set({ area })}
            options={[{ value: 'quarter', label: '顶部' }, { value: 'half', label: '上半屏' }, { value: 'full', label: '全屏' }]} />
        </div>

        <h3 className="float-sub">屏蔽</h3>
        <Chips label="关键词" placeholder="回车添加，支持正则表达式" values={danmaku.filter.blockedPatterns} invalid={invalid}
          onChange={(blockedPatterns) => set({ filter: { ...danmaku.filter, blockedPatterns } })} />
        <Chips label="用户" placeholder="回车添加用户名" values={danmaku.filter.blockedUsers}
          onChange={(blockedUsers) => set({ filter: { ...danmaku.filter, blockedUsers } })} />
        <Range label="长度上限" value={danmaku.filter.maxLength} min={0} max={80} step={5} unit="字"
          format={(v) => v === 0 ? '不限' : `${v} 字`}
          onChange={(maxLength) => set({ filter: { ...danmaku.filter, maxLength } })} />
      </div>
    </aside>
  )
}

function Range({ label, value, min, max, step, unit, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  format?: (value: number) => string
  onChange: (value: number) => void
}): React.ReactNode {
  return (
    <label className="range">
      <span className="range-head">
        <span>{label}</span>
        <span className="num">{format ? format(value) : `${value}${unit}`}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function Chips({ label, placeholder, values, invalid, onChange }: {
  label: string; placeholder: string; values: string[]
  invalid?: Map<string, string>
  onChange: (values: string[]) => void
}): React.ReactNode {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const value = draft.trim()
    if (!value) return
    if (!values.includes(value)) onChange([...values, value])
    setDraft('')
  }
  return (
    <div className="chips" role="group" aria-label={`屏蔽${label}`}>
      <span className="field-label">{label}</span>
      <div className="chips-box">
        {values.map((value) => (
          <span key={value} className={`chip-tag ${invalid?.has(value) ? 'is-invalid' : ''}`.trim()} title={invalid?.get(value)}>
            {value}
            <button type="button" aria-label={`移除 ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
              <Icon name="close" />
            </button>
          </span>
        ))}
        <input value={draft} placeholder={values.length === 0 ? placeholder : ''} aria-label={`添加屏蔽${label}`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); add() }
            else if (event.key === 'Backspace' && draft === '' && values.length > 0) onChange(values.slice(0, -1))
          }}
          onBlur={add} />
      </div>
    </div>
  )
}
