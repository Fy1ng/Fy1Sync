import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { Session } from './app/session'
import { SessionProvider } from './app/SessionContext'
import { Studio } from './studio/Studio'
import { TitleBar } from './studio/TitleBar'
import { FrontendReady } from './app/FrontendReady'
import './studio/titlebar.css'

const PipPage = lazy(() => import('./studio/pip/PipPage'))

/** The session outlives every render, so it is created once, and only for pages that use it. */
let session: Session | null = null
function sharedSession(): Session {
  session ??= new Session()
  return session
}

function App(): React.ReactNode {
  if (window.location.pathname.replace(/\/+$/, '') === '/pip') {
    return (
      <Suspense fallback={null}>
        <PipPage />
      </Suspense>
    )
  }
  return (
    <SessionProvider session={sharedSession()}>
      <TitleBar />
      <Studio />
      <FrontendReady />
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
