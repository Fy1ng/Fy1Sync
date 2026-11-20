import { useEffect, useRef, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import {
  DEFAULT_SHORTCUTS, isShortcutCode, MAX_SHORTCUT_KEYS, SEEK_SHORTCUT_STEPS, SHORTCUT_ACTIONS,
  SHORTCUT_LABELS, shortcutActionFor, shortcutKeyLabel, type ShortcutAction,
} from '../app/shortcuts'
import { Icon } from './kit'

type Slot = { action: ShortcutAction; index: number }
type Edit = Slot & (
  { kind: 'recording'; error?: string } | { kind: 'conflict'; code: string; owner: ShortcutAction }
)

export function ShortcutSettings(): React.ReactNode {
  const session = useSession()
  const { settings } = useSessionSnapshot()
  const { shortcuts } = settings
  const [edit, setEdit] = useState<Edit | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)

  const cancel = (): void => {
    trigger.current?.focus()
    setEdit(null)
  }

  const bind = ({ action, index }: Slot, code: string, owner?: ShortcutAction): void => {
    const current = session.settings.shortcuts
    const codes = [...current[action]]
    codes[index] = code
    const next = { ...current, [action]: codes }
    if (owner && owner !== action) next[owner] = current[owner].filter(key => key !== code)
    session.updateSettings({ shortcuts: next })
    cancel()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.key === 'Escape' || event.code === 'Escape') && (edit || event.repeat)) {
        event.preventDefault()
        event.stopPropagation()
        if (edit) cancel()
        return
      }
      if (edit?.kind !== 'recording') return
      event.stopPropagation()
      if (event.code === 'Tab' || event.key === 'Tab') return
      event.preventDefault()
      if (event.repeat) return
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !isShortcutCode(event.code)) {
        setEdit({ ...edit, error: '不能绑定此按键，请按单个非保留按键' })
        return
      }
      const current = session.settings.shortcuts
      const owner = shortcutActionFor(current, event.code)
      if (owner === edit.action && current[owner][edit.index] !== event.code) {
        setEdit({ ...edit, error: `此动作已绑定 ${shortcutKeyLabel(event.code)}` })
      } else if (owner && owner !== edit.action) {
        setEdit({ action: edit.action, index: edit.index, kind: 'conflict', code: event.code, owner })
      } else {
        bind(edit, event.code)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [edit, session])

  return <section className="group" aria-label="快捷键">
    <div className="row-split">
      <h3>快捷键</h3>
      <button type="button" className="btn-quiet small" onClick={() => {
        setEdit(null)
        session.updateSettings({ shortcuts: DEFAULT_SHORTCUTS })
      }}>恢复默认</button>
    </div>
    <table className="shortcut-table">
      <thead><tr><th scope="col">动作</th><th scope="col">按键</th><th scope="col">步长</th></tr></thead>
      <tbody>{SHORTCUT_ACTIONS.map(action => {
        const label = SHORTCUT_LABELS[action]
        const codes = shortcuts[action]
        const active = edit?.action === action ? edit : null
        const steps = action === 'seekBack' || action === 'seekForward' ? SEEK_SHORTCUT_STEPS
          : action === 'nudgeBack' || action === 'nudgeForward' ? { normal: settings.largeStepSeconds, shift: settings.smallStepSeconds } : null
        return <tr key={action}>
          <th scope="row">{label}</th>
          <td>
            <div className="shortcut-keys">
              {Array.from({ length: Math.min(codes.length + 1, MAX_SHORTCUT_KEYS) }, (_, index) => {
                const code = codes[index]
                const keyLabel = code && shortcutKeyLabel(code)
                const selected = active?.index === index
                const recording = selected && active.kind === 'recording'
                const buttonLabel = recording ? '按下新按键' : keyLabel ?? (codes.length ? '添加' : '未设置')
                return <span className="shortcut-key" key={index}>
                  <button type="button" className={`btn small${recording ? ' shortcut-recording' : ''}`}
                    ref={selected ? trigger : undefined}
                    aria-label={`${label}：${recording ? buttonLabel : keyLabel ? `修改 ${keyLabel}` : `添加按键${codes.length ? '' : '（未设置）'}`}`}
                    title={recording ? '按 Esc 取消' : undefined}
                    onClick={event => {
                      event.currentTarget.focus()
                      setEdit(recording ? null : { action, index, kind: 'recording' })
                    }}
                    onBlur={() => {
                      if (recording) setEdit(previous => previous?.kind === 'recording' && previous.action === action && previous.index === index ? null : previous)
                    }}>{buttonLabel}</button>
                  {code && !recording && <button type="button" className="icon-btn small" aria-label={`${label}：清除 ${keyLabel}`} title={`清除 ${keyLabel}`}
                    onClick={() => {
                      setEdit(null)
                      session.updateSettings({ shortcuts: { ...shortcuts, [action]: codes.filter(key => key !== code) } })
                    }}><Icon name="close" /></button>}
                </span>
              })}
            </div>
            {active?.kind === 'recording' && active.error && <p className="form-error" role="alert">{active.error}</p>}
            {active?.kind === 'conflict' && <div className="shortcut-conflict">
              <p className="note-warn" role="status">{shortcutKeyLabel(active.code)} 已被「{SHORTCUT_LABELS[active.owner]}」占用</p>
              <button type="button" className="btn small" autoFocus onClick={() => bind(active, active.code, active.owner)}>替换</button>
              <button type="button" className="btn-quiet small" onClick={cancel}>取消</button>
            </div>}
          </td>
          <td>{steps && <div className="shortcut-steps"><span>{steps.normal} 秒</span><span>Shift：{steps.shift} 秒</span></div>}</td>
        </tr>
      })}</tbody>
    </table>
  </section>
}
