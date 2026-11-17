/**
 * Session notices, top centre. Information fades on its own; warnings linger longer, since
 * a refused seek is the difference between "aligned" and "looks aligned"; errors stay until
 * dismissed.
 */

import { useEffect, useState } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { Icon } from './kit'
import { ErrorDetailsButton } from '../ui/ErrorDetails'

const LIFETIME_MS = { info: 3500, warn: 9000, error: 0 } as const

export function Toasts(): React.ReactNode {
  const session = useSession()
  const { notices } = useSessionSnapshot()
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())

  useEffect(() => {
    const timers = notices
      .filter((notice) => LIFETIME_MS[notice.kind] > 0 && !expanded.has(notice.id))
      .map((notice) => setTimeout(() => session.dismissNotice(notice.id), LIFETIME_MS[notice.kind]))
    return () => timers.forEach(clearTimeout)
  }, [notices, session, expanded])

  if (notices.length === 0) return null
  // The same warning fired twice in a row is one thing to read, not two.
  const latest = new Map<string, typeof notices[number]>()
  for (const notice of notices) {
    const key = JSON.stringify([notice.kind, notice.text, notice.detail])
    if (!latest.has(key)) latest.set(key, notice)
  }
  return (
    <div className="toasts" role="status" aria-live="polite">
      {[...latest.values()].slice(0, 3).map((notice) => (
        <div key={notice.id} className={`toast is-${notice.kind}`}>
          <span>{notice.text}{notice.kind !== 'info' && <ErrorDetailsButton error={notice.detail ?? { message: notice.text }} onOpenChange={open => setExpanded(current => {
            const next = new Set([...current].filter(id => notices.some(notice => notice.id === id)))
            if (open) next.add(notice.id); else next.delete(notice.id)
            return next
          })} />}</span>
          <button type="button" aria-label="关闭提示" onClick={() => session.dismissNotice(notice.id)}><Icon name="close" /></button>
        </div>
      ))}
    </div>
  )
}
