/**
 * Session notices, top centre. Information fades on its own; warnings linger longer, since
 * a refused seek is the difference between "aligned" and "looks aligned"; errors stay until
 * dismissed.
 */

import { useEffect } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { Icon } from './kit'

const LIFETIME_MS = { info: 3500, warn: 9000, error: 0 } as const

export function Toasts(): React.ReactNode {
  const session = useSession()
  const { notices } = useSessionSnapshot()

  useEffect(() => {
    const timers = notices
      .filter((notice) => LIFETIME_MS[notice.kind] > 0)
      .map((notice) => setTimeout(() => session.dismissNotice(notice.id), LIFETIME_MS[notice.kind]))
    return () => timers.forEach(clearTimeout)
  }, [notices, session])

  if (notices.length === 0) return null
  // The same warning fired twice in a row is one thing to read, not two.
  const latest = new Map(notices.map((notice) => [notice.text, notice]))
  return (
    <div className="toasts" role="status" aria-live="polite">
      {[...latest.values()].slice(-3).map((notice) => (
        <div key={notice.id} className={`toast is-${notice.kind}`}>
          <span>{notice.text}</span>
          <button type="button" aria-label="关闭提示" onClick={() => session.dismissNotice(notice.id)}><Icon name="close" /></button>
        </div>
      ))}
    </div>
  )
}
