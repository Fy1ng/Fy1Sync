/**
 * How danmaku look over the picture, which ones never show, and what is added to the ones
 * sent. Every change applies live to the running layer, so there is no save button: the
 * picture behind is the preview.
 *
 * Two stores sit behind this panel. Look and blocking live in the renderer's settings;
 * spacing, duplicate handling, the bot filter, sender details and the prefix/suffix are kept
 * by the main process (so the PiP window shares them) and change only through its IPC, with
 * the saved value coming back as the source of truth.
 */

import { useEffect, useState } from 'react'
import { apiClient } from '../app/apiClient'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DanmakuPreferences } from '../core/danmakuProcessing'
import type { MessageAffixes } from '../core/messageComposition'
import { useComposer } from './composer'
import { Icon, Range, Segmented, Switch } from './kit'

export function DanmakuPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const session = useSession()
  const { settings, danmakuPreferences: prefs } = useSessionSnapshot()
  const danmaku = settings.danmaku
  const composer = useComposer()
  const [problem, setProblem] = useState<string | null>(null)
  const setPrefs = (patch: Partial<DanmakuPreferences>): void => {
    setProblem(null)
    void apiClient.feature('setDanmakuPreferences', patch).then((result) => {
      if (result.ok) session.configureDanmakuProcessing(result.value.preferences)
      else setProblem(result.message)
    })
  }
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

        <h3 className="float-sub">处理</h3>
        <Range label="行间距" value={prefs.verticalGapPx} min={0} max={64} step={1} unit="px"
          onChange={(verticalGapPx) => setPrefs({ verticalGapPx })} />
        <div className="field-stack">
          <span className="field-label">重复弹幕</span>
          <Segmented label="重复弹幕" value={prefs.duplicateMode} onChange={(duplicateMode) => setPrefs({ duplicateMode })}
            options={[{ value: 'all', label: '全部显示' }, { value: 'single', label: '只显示一条' }, { value: 'combo', label: '合并计数' }]} />
        </div>
        {prefs.duplicateMode !== 'all' && (
          <Range label="合并窗口" value={prefs.duplicateWindowSeconds} min={1} max={30} step={1} unit=" 秒"
            onChange={(duplicateWindowSeconds) => setPrefs({ duplicateWindowSeconds })} />
        )}
        <Switch label="过滤疑似机器人弹幕" detail="依据弹幕是否缺少平台评分字段判断，可能误过滤正常弹幕"
          checked={prefs.filterSuspectedBots} onChange={(filterSuspectedBots) => setPrefs({ filterSuspectedBots })} />
        <Switch label="用户详情" detail="在弹幕菜单中查看等级、贵族与粉丝牌"
          checked={prefs.showUserDetails} onChange={(showUserDetails) => setPrefs({ showUserDetails })} />

        <h3 className="float-sub">发送</h3>
        <Affixes value={composer.affixes} onProblem={setProblem} />
        {problem && <p className="form-error" role="alert">{problem}</p>}
      </div>
    </aside>
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

/**
 * Prefix and suffix for typed messages ("+1" always goes out verbatim). Edited as drafts and
 * saved on blur, so every keystroke is not a write to disk.
 */
function Affixes({ value, onProblem }: { value: MessageAffixes; onProblem: (problem: string | null) => void }): React.ReactNode {
  const [prefix, setPrefix] = useState(value.prefix)
  const [suffix, setSuffix] = useState(value.suffix)
  useEffect(() => { setPrefix(value.prefix); setSuffix(value.suffix) }, [value.prefix, value.suffix])
  const save = (patch: Partial<MessageAffixes>): void => {
    onProblem(null)
    void apiClient.feature('setMessageAffixes', patch).then((result) => { if (!result.ok) onProblem(result.message) })
  }
  return (
    <>
      <Switch label="前缀与后缀" detail="附加到手动发送的弹幕，+1 不附加" checked={value.enabled}
        onChange={(enabled) => save({ enabled })} />
      {value.enabled && (
        <div className="affixes">
          <input className="text-input" value={prefix} maxLength={128} aria-label="前缀" placeholder="前缀"
            onChange={(event) => setPrefix(event.target.value)} onBlur={() => { if (prefix !== value.prefix) save({ prefix }) }} />
          <input className="text-input" value={suffix} maxLength={128} aria-label="后缀" placeholder="后缀"
            onChange={(event) => setSuffix(event.target.value)} onBlur={() => { if (suffix !== value.suffix) save({ suffix }) }} />
          <p className="muted affixes-preview">预览：{prefix}弹幕内容{suffix}</p>
        </div>
      )}
    </>
  )
}
