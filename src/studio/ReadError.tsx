import { ErrorText } from '../ui/ErrorDetails'

export function ReadError({ error, onRetry, detail }: { error: string; onRetry: () => void; detail?: unknown }): React.ReactNode {
  return <div>
    <p className="form-error" role="alert"><ErrorText error={detail ?? error} message={error} /></p>
    <button type="button" className="btn-quiet small" onClick={onRetry}>重试</button>
  </div>
}
