/**
 * React's view of the session.
 *
 * `useSyncExternalStore` is the right primitive here rather than state-in-a-provider:
 * the session already is an external store with a `subscribe`/`getSnapshot` pair, and
 * it emits changes from media events that React did not initiate. Using the official
 * hook means a change arriving mid-render is torn-read safe, which a `useEffect` +
 * `setState` bridge would not be.
 */

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { Session, type SessionSnapshot } from './session'

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({
  session,
  children,
}: {
  session: Session
  children: ReactNode
}): ReactNode {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession 必须在 SessionProvider 内使用')
  return session
}

export function useSessionSnapshot(): SessionSnapshot {
  const session = useSession()
  return useSyncExternalStore(
    (onChange) => session.subscribe(() => onChange()),
    () => session.snapshot,
    () => session.snapshot,
  )
}
