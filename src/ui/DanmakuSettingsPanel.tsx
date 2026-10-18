/**
 * Danmaku settings, with the two filter sub-pages sliding in from the right.
 *
 * The sub-page pattern comes from docs/ui-layout.md: regex and username lists are long
 * enough to need their own space, but pushing them into a separate dialog would lose the
 * context of the panel they belong to. One container, two positions.
 */

import { useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import type { DanmakuArea } from '../core/danmakuLanes'
import { DropUp } from './controls/DropUp'
import { Slider } from './controls/Slider'
import { Toggle } from './controls/Toggle'

type SubPage = 'none' | 'patterns' | 'users'

export function DanmakuSettingsPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  const { danmaku } = snapshot.settings
  const [subPage, setSubPage] = useState<SubPage>('none')

  return (
    <div className="panel danmaku-panel" data-subpage={subPage}>
      <div className="panel-pane">
        <header className="panel-header">
          <h3>弹幕设置</h3>
          <button type="button" className="ghost small" onClick={onClose} aria-label="关闭弹幕设置">
            ×
          </button>
        </header>

        <Toggle
          label="显示弹幕"
          checked={danmaku.enabled}
          onChange={(checked) => session.updateDanmakuSettings({ enabled: checked })}
        />

        <Slider
          label="字号"
          value={danmaku.fontSize}
          min={14}
          max={48}
          step={1}
          formatValue={(value) => `${value} px`}
          onInput={(value) => session.updateDanmakuSettings({ fontSize: value })}
        />
        <Slider
          label="速度"
          value={danmaku.speed}
          min={60}
          max={360}
          step={10}
          formatValue={(value) => `${value} px/s`}
          onInput={(value) => session.updateDanmakuSettings({ speed: value })}
        />
        <Slider
          label="不透明度"
          value={danmaku.opacity}
          min={0.2}
          max={1}
          step={0.05}
          formatValue={(value) => `${Math.round(value * 100)}%`}
          onInput={(value) => session.updateDanmakuSettings({ opacity: value })}
        />
        <Slider
          label="密度"
          value={danmaku.density}
          min={0.1}
          max={1}
          step={0.1}
          formatValue={(value) => `${Math.round(value * 100)}%`}
          onInput={(value) => session.updateDanmakuSettings({ density: value })}
        />

        <DropUp
          label="显示区域"
          align="left"
          value={danmaku.area}
          options={[
            { value: 'quarter', label: '四分之一屏' },
            { value: 'half', label: '半屏' },
            { value: 'full', label: '全屏' },
          ]}
          onChange={(area: DanmakuArea) => session.updateDanmakuSettings({ area })}
        />

        <Slider
          label="最大长度"
          value={danmaku.filter.maxLength}
          min={0}
          max={80}
          step={5}
          formatValue={(value) => (value === 0 ? '不限制' : `${value} 字`)}
          onInput={(value) =>
            session.updateDanmakuSettings({ filter: { ...danmaku.filter, maxLength: value } })
          }
        />

        <div className="panel-links">
          <button type="button" onClick={() => setSubPage('patterns')}>
            屏蔽正则
            <span className="badge">{danmaku.filter.blockedPatterns.length}</span>
          </button>
          <button type="button" onClick={() => setSubPage('users')}>
            屏蔽用户
            <span className="badge">{danmaku.filter.blockedUsers.length}</span>
          </button>
        </div>
      </div>

      {subPage !== 'none' && (
        <ListEditor
          kind={subPage}
          onBack={() => setSubPage('none')}
          values={
            subPage === 'patterns' ? danmaku.filter.blockedPatterns : danmaku.filter.blockedUsers
          }
          invalid={session.invalidPatterns}
          onChange={(values) =>
            session.updateDanmakuSettings({
              filter:
                subPage === 'patterns'
                  ? { ...danmaku.filter, blockedPatterns: values }
                  : { ...danmaku.filter, blockedUsers: values },
            })
          }
        />
      )}
    </div>
  )
}

interface ListEditorProps {
  kind: 'patterns' | 'users'
  values: string[]
  invalid: readonly { source: string; message: string }[]
  onChange: (values: string[]) => void
  onBack: () => void
}

function ListEditor({ kind, values, invalid, onChange, onBack }: ListEditorProps): React.ReactNode {
  const [draft, setDraft] = useState('')
  const isPatterns = kind === 'patterns'

  const add = (): void => {
    const value = draft.trim()
    if (value === '' || values.includes(value)) return
    onChange([...values, value])
    setDraft('')
  }

  return (
    <div className="panel-pane panel-subpage">
      <header className="panel-header">
        <button type="button" className="ghost small" onClick={onBack} aria-label="返回">
          ‹
        </button>
        <h3>{isPatterns ? '屏蔽正则' : '屏蔽用户'}</h3>
      </header>

      <form
        className="list-add"
        onSubmit={(event) => {
          event.preventDefault()
          add()
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={isPatterns ? '例如 ^6+$ 或 关注了主播' : '用户名'}
          aria-label={isPatterns ? '新增屏蔽规则' : '新增屏蔽用户'}
        />
        <button type="submit">添加</button>
      </form>

      {isPatterns && (
        <p className="hint">
          按正则匹配，忽略大小写。普通文字也可以直接写，相当于包含匹配。写错的正则会在下面标出，
          不会静默失效。
        </p>
      )}

      <ul className="list-editor">
        {values.length === 0 && <li className="is-empty">暂无规则</li>}
        {values.map((value) => {
          const problem = invalid.find((entry) => entry.source === value)
          return (
            <li key={value} className={problem ? 'is-invalid' : ''}>
              <code>{value}</code>
              {problem && <span className="list-error">{problem.message}</span>}
              <button
                type="button"
                aria-label={`删除 ${value}`}
                onClick={() => onChange(values.filter((entry) => entry !== value))}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
