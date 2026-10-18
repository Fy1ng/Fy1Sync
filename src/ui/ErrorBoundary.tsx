/**
 * Last line of defence around the tree.
 *
 * A render crash in a player is worse than in most apps: the media elements survive
 * inside the engine, so an unmounted tree leaves audio playing with no controls. Showing
 * a reload panel keeps the user in charge of that.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink here; there is no telemetry endpoint by design.
    console.error('渲染出错', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>页面出错了</h1>
        <p className="crash-message">{error.message}</p>
        <p className="crash-hint">
          媒体元素仍在后台，刷新页面即可恢复。若反复出现，请在设置里清除本地偏好后重试。
        </p>
        <div className="crash-actions">
          <button type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              try {
                window.localStorage.removeItem('stream-sync.settings.v1')
              } catch {
                // Private mode or a blocked quota. Reloading is still worth trying.
              }
              window.location.reload()
            }}
          >
            清除偏好并刷新
          </button>
        </div>
      </div>
    )
  }
}
