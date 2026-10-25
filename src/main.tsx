/**
 * Application entry point.
 *
 * Two routes, no router library: this app has exactly two pages and they never nest.
 * `/admin` is the Profile Editor, everything else is the player. The editor is lazy so
 * the player's first paint does not carry the template-matching UI it will never use.
 */

import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { Session } from './app/session'
import { SessionProvider } from './app/SessionContext'
import { Studio } from './studio/Studio'

const AdminPage = lazy(() => import('./ui/admin/entry'))

/** The session outlives every render, so it is created once here, not in a component. */
const session = new Session()

function currentRoute(): 'player' | 'admin' {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/admin') ? 'admin' : 'player'
}

function App(): React.ReactNode {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    // Back/forward still work even without a router: the two pages are independent.
    const onPopState = (): void => setRoute(currentRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  if (route === 'admin') {
    return (
      <Suspense fallback={<div className="page-loading">正在加载场景配置器…</div>}>
        <AdminPage />
      </Suspense>
    )
  }
  return <Studio />
}

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <SessionProvider session={session}>
        <App />
      </SessionProvider>
    </ErrorBoundary>
  </StrictMode>,
)
