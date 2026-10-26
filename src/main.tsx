/**
 * Application entry point.
 *
 * Three routes, no router library: the pages never nest. `/admin` is the Profile Editor,
 * `/pip` is the enhanced picture-in-picture window, everything else is the player. The
 * editor and the PiP page are lazy so the player's first paint carries neither.
 *
 * The PiP window loads this same document in its own restricted BrowserWindow. It must not
 * build the player's `Session`: that would start recognition, sync and a second set of
 * subscriptions in a window that only shows one stream.
 */

import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { Session } from './app/session'
import { SessionProvider } from './app/SessionContext'
import { Studio } from './studio/Studio'

const AdminPage = lazy(() => import('./ui/admin/entry'))
const PipPage = lazy(() => import('./studio/pip/PipPage'))

type Route = 'player' | 'admin' | 'pip'

function currentRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path.endsWith('/pip')) return 'pip'
  return path.endsWith('/admin') ? 'admin' : 'player'
}

/** The session outlives every render, so it is created once, and only for pages that use it. */
let session: Session | null = null
function sharedSession(): Session {
  session ??= new Session()
  return session
}

function App(): React.ReactNode {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    // Back/forward still work even without a router: the pages are independent.
    const onPopState = (): void => setRoute(currentRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  if (route === 'pip') {
    return (
      <Suspense fallback={null}>
        <PipPage />
      </Suspense>
    )
  }
  return (
    <SessionProvider session={sharedSession()}>
      {route === 'admin' ? (
        <Suspense fallback={<div className="page-loading">正在加载场景配置器…</div>}>
          <AdminPage />
        </Suspense>
      ) : <Studio />}
    </SessionProvider>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
