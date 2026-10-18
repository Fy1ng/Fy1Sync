/**
 * Transient messages from the session.
 *
 * Warnings here matter more than usual: a refused seek or an exhausted rewind buffer is
 * the difference between "synced" and "looks synced", so each stays until dismissed or
 * until it ages out. Errors never auto-dismiss.
 */

import { useEffect } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'

const AUTO_DISMISS_MS = { info: 4000, warn: 9000, error: 0 } as const

export function NoticeStrip(): React.ReactNode {
  const session = useSession()
  const { notices } = useSessionSnapshot()

  useEffect(() => {
    const timers = notices
      .filter((notice) => AUTO_DISMISS_MS[notice.kind] > 0)
      .map((notice) =>
        setTimeout(() => session.dismissNotice(notice.id), AUTO_DISMISS_MS[notice.kind]),
      )
    return () => timers.forEach(clearTimeout)
  }, [notices, session])

  if (notices.length === 0) return null

  return (
    <div className="notice-strip" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice notice-${notice.kind}`}>
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => session.dismissNotice(notice.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
