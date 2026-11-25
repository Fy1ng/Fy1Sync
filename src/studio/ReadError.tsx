import { ErrorActionRow } from '../ui/ErrorDetails'

export function ReadError({ error, onRetry, detail }: { error: string; onRetry: () => void; detail?: unknown }): React.ReactNode {
  return <div className="field-stack" role="alert">
    <p className="form-error">{error}</p>
    <ErrorActionRow error={detail ?? error} summary={error}>
      <button type="button" className="btn-quiet small" onClick={onRetry}>重试</button>
    </ErrorActionRow>
  </div>
}
