/**
 * Collapsible direct-stream options (custom label, Referer, User-Agent, extra headers)
 * shared by Intake, SourceChip, ExtraStreams, and Favorites.
 */

import { hasDirectDraft, type DirectStreamDraft } from '../core/directStream'
import { parseSourceInput } from '../core/mediaSources'
import { parseRoomInput } from '../core/sourceDanmaku'
import { Icon } from './kit'

export function isDirectStreamInput(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('/')) return false
  if (parseRoomInput(trimmed) !== null) return false
  const parsed = parseSourceInput(trimmed)
  return parsed.ok && parsed.platform === 'direct'
}

export function DirectStreamFields({
  input,
  draft,
  open,
  disabled = false,
  onToggle,
  onChange,
}: {
  input: string
  draft: DirectStreamDraft
  open: boolean
  disabled?: boolean
  onToggle: () => void
  onChange: (next: DirectStreamDraft) => void
}): React.ReactNode {
  const detected = isDirectStreamInput(input)
  const configured = hasDirectDraft(draft)
  const update = <K extends keyof DirectStreamDraft>(key: K, value: DirectStreamDraft[K]): void => {
    onChange({ ...draft, [key]: value })
  }

  return (
    <div className="direct-options" data-open={open || undefined}>
      <div className="direct-options-bar">
        {detected ? (
          <span className="direct-badge" role="status">已识别纯直播流直链</span>
        ) : (
          <span className="muted direct-hint">支持直接粘贴 m3u8、flv、ts 等 HTTP/HTTPS 直播流</span>
        )}
        <button
          type="button"
          className={`btn-quiet small direct-toggle ${open || configured ? 'is-active' : ''}`.trim()}
          disabled={disabled}
          aria-expanded={open}
          onClick={onToggle}
        >
          <Icon name="tune" />
          <span>{open ? '收起纯流选项' : configured ? '纯流选项（已填）' : '纯流选项'}</span>
        </button>
      </div>
      {open && (
        <div className="direct-options-panel" role="group" aria-label="纯直播流选项">
          <div className="direct-options-grid">
            <label className="field-stack">
              <span className="field-label">片源名称</span>
              <input
                className="text-input"
                value={draft.label}
                maxLength={100}
                disabled={disabled}
                aria-label="直链名称"
                placeholder="可选，例如：官方主舞台"
                onChange={event => update('label', event.target.value)}
              />
            </label>
            <label className="field-stack">
              <span className="field-label">Referer</span>
              <input
                className="text-input"
                value={draft.referer}
                disabled={disabled}
                aria-label="直链 Referer"
                placeholder="可选，例如：https://example.com/"
                spellCheck={false}
                onChange={event => update('referer', event.target.value)}
              />
            </label>
          </div>
          <label className="field-stack">
            <span className="field-label">User-Agent</span>
            <input
              className="text-input"
              value={draft.userAgent}
              disabled={disabled}
              aria-label="直链 User-Agent"
              placeholder="可选，自定义请求 User-Agent"
              spellCheck={false}
              onChange={event => update('userAgent', event.target.value)}
            />
          </label>
          <label className="field-stack">
            <span className="field-label">其他请求头</span>
            <textarea
              className="text-input"
              rows={2}
              value={draft.customHeaders}
              disabled={disabled}
              aria-label="直链其他请求头"
              placeholder={'可选，每行「名称: 值」，例如 Origin: https://example.com'}
              spellCheck={false}
              onChange={event => update('customHeaders', event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  )
}
