import { useCallback, useId, useState } from 'react'
import { displayError, errorDetails, errorMessage, shouldShowErrorDetails, type DisplayError, type ErrorDetails as ErrorFields } from '../core/errorDetails'
import './errorDetails.css'

function useErrorDetailsDisclosure(error: unknown, summary?: string, onOpenChange?: (open: boolean) => void) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<DisplayError | null>(null)
  const id = useId()
  const fields = errorDetails(error)
  const visible = shouldShowErrorDetails(error, fields, summary)
  const content = visible ? JSON.stringify(fields, null, 2) : ''
  const toggle = () => {
    const next = !open
    setOpen(next)
    onOpenChange?.(next)
    setCopied(false)
    setCopyError(null)
  }
  const copy = () => {
    void Promise.resolve().then(() => navigator.clipboard.writeText(content)).then(() => {
      setCopied(true)
      setCopyError(null)
    }, caught => {
      setCopied(false)
      setCopyError(displayError(caught, '复制失败，可选择下方内容手动复制'))
    })
  }
  return { visible, open, copied, copyError, id, content, toggle, copy }
}

function ErrorDetailsPanel({ id, copied, copyError, content, onCopy }: {
  id: string
  copied: boolean
  copyError: DisplayError | null
  content: string
  onCopy: () => void
}): React.ReactNode {
  return <span id={id} className="error-details-panel" role="region" aria-label="原始错误信息" onClick={event => event.stopPropagation()}>
    <span className="error-details-toolbar">
      <span>认证信息已脱敏</span>
      <button type="button" onClick={onCopy}>{copied ? '已复制' : '复制错误信息'}</button>
    </span>
    {copyError && <span role="alert"><ErrorText error={copyError} /></span>}
    <code className="error-details-code" tabIndex={0}>{content}</code>
  </span>
}

/** Each error owns its fields, so concurrent operations with the same summary cannot be confused. */
export function ErrorDetailsButton({ error, summary, label = '查看原始错误', onOpenChange }: { error: unknown; summary?: string; label?: string; onOpenChange?: (open: boolean) => void }): React.ReactNode {
  const state = useErrorDetailsDisclosure(error, summary, onOpenChange)
  if (!state.visible) return null
  return <span className="error-details" onClick={event => event.stopPropagation()}>
    <button type="button" className="error-details-toggle" aria-expanded={state.open} aria-controls={state.id} onClick={state.toggle}>
      {state.open ? '收起原始错误' : label}
    </button>
    {state.open && <ErrorDetailsPanel id={state.id} copied={state.copied} copyError={state.copyError} content={state.content} onCopy={state.copy} />}
  </span>
}

/**
 * Single horizontal row for quick-fix buttons plus optional raw-error toggle.
 * Every button stays on one horizontal line while the expanded diagnostic panel renders underneath.
 */
export function ErrorActionRow({ error, summary, children }: { error?: unknown; summary?: string; children?: React.ReactNode }): React.ReactNode {
  const state = useErrorDetailsDisclosure(error, summary)
  const hasActions = Boolean(children) || state.visible
  if (!hasActions) return null
  return <>
    <span className="error-action-row" onClick={event => event.stopPropagation()}>
      {children}
      {state.visible && (
        <button type="button" className="error-details-toggle" aria-expanded={state.open} aria-controls={state.id} onClick={state.toggle}>
          {state.open ? '收起原始错误' : '查看原始错误'}
        </button>
      )}
    </span>
    {state.visible && state.open && <ErrorDetailsPanel id={state.id} copied={state.copied} copyError={state.copyError} content={state.content} onCopy={state.copy} />}
  </>
}

/** Phrasing content: safe inside existing paragraphs, inline status rows and toast text. */
export function ErrorText({ error, message, summary }: { error: unknown; message?: React.ReactNode; summary?: string }): React.ReactNode {
  const textSummary = summary ?? (typeof message === 'string' ? message : undefined)
  return <>{message ?? errorMessage(error)} <ErrorDetailsButton error={error} summary={textSummary} /></>
}

export interface ErrorSetter {
  (update: (previous: string) => unknown): void
  (value: unknown): void
}
/** Preserve existing summary-string state while retaining the complete failure beside it. */
export function useErrorState(initial: string | null = ''): [string, ErrorSetter, ErrorFields | null] {
  const [state, setState] = useState<DisplayError | null>(() => initial ? displayError(initial) : null)
  const update = useCallback((next: unknown) => {
    setState(previous => {
      const value = typeof next === 'function' ? (next as (previous: string) => unknown)(previous?.message ?? '') : next
      if (value === null || value === undefined || value === '') return null
      if (typeof next === 'function' && value === previous?.message) return previous
      return displayError(value)
    })
  }, [])
  return [state?.message ?? '', update, state?.detail ?? null]
}
