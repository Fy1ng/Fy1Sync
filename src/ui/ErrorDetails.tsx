import { useCallback, useId, useState } from 'react'
import { displayError, errorDetails, errorMessage, hasAdditionalErrorDetails, type DisplayError, type ErrorDetails as ErrorFields } from '../core/errorDetails'
import './errorDetails.css'

/** Each error owns its fields, so concurrent operations with the same summary cannot be confused. */
export function ErrorDetailsButton({ error, summary, label = '查看原始错误', onOpenChange }: { error: unknown; summary?: string; label?: string; onOpenChange?: (open: boolean) => void }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<DisplayError | null>(null)
  const id = useId()
  const fields = errorDetails(error)
  if (!hasAdditionalErrorDetails(fields, summary)) return null
  const content = JSON.stringify(fields, null, 2)
  return <span className="error-details" onClick={event => event.stopPropagation()}>
    <button type="button" className="error-details-toggle" aria-expanded={open} aria-controls={id}
      onClick={() => { setOpen(!open); onOpenChange?.(!open); setCopied(false); setCopyError(null) }}>{open ? '收起原始错误' : label}</button>
    {open && <span id={id} className="error-details-panel" role="region" aria-label="原始错误信息">
      <span className="error-details-toolbar"><span>认证信息已脱敏</span><button type="button" onClick={() => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(content)).then(() => { setCopied(true); setCopyError(null) }, error => {
          setCopied(false); setCopyError(displayError(error, '复制失败，可选择下方内容手动复制'))
        })
      }}>{copied ? '已复制' : '复制错误信息'}</button></span>
      {copyError && <span role="alert"><ErrorText error={copyError} /></span>}
      <code className="error-details-code" tabIndex={0}>{content}</code>
    </span>}
  </span>
}

/** Phrasing content: safe inside existing paragraphs, inline status rows and toast text. */
export function ErrorText({ error, message }: { error: unknown; message?: React.ReactNode }): React.ReactNode {
  return <>{message ?? errorMessage(error)} <ErrorDetailsButton error={error} summary={typeof message === 'string' ? message : undefined} /></>
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
