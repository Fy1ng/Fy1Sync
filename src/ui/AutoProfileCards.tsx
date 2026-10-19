import { useEffect, useRef } from 'react'
import { useSession, useSessionSnapshot } from '../app/SessionContext'
import { roleName } from '../app/session'
import type { RoiRect } from '../core/profileSchema'
import { SOURCE_ROLES, type SourceRole } from '../core/types'
import { AUTO_PROFILE_TEXT } from '../recognition/autoProfile'

export function AutoProfileCards(): React.ReactNode {
  const session = useSession()
  const snapshot = useSessionSnapshot()
  return <div className="auto-profile-cards">
    {SOURCE_ROLES.map(role => {
      const state = snapshot.autoProfiles[role]
      if (state.phase === 'idle') return null
      const busy = state.phase === 'locating' || state.phase === 'learning'
      return <section key={role} className="auto-profile-card" data-role={role} aria-label={`${roleName(role)}自动预设`}>
        <h4>{roleName(role)}</h4>
        <p className="auto-profile-phase" aria-live="polite">{AUTO_PROFILE_TEXT[state.phase]}{state.accepted ? ' (本次已使用)' : ''}</p>
        {state.candidate && <>
          <RoiPreview role={role} roi={state.candidate.roi} />
          <p className="hint">已学字符: {state.learnedChars.join(' ')}. 置信度: {(state.confidence * 100).toFixed(0)}%</p>
        </>}
        {state.reason && <p className="status-warning">{state.reason}</p>}
        <div className="auto-actions">
          {state.phase === 'ready' && !state.accepted && <button type="button" className="primary" onClick={() => session.acceptAutoProfile(role)}>使用</button>}
          {!busy && <button type="button" onClick={() => session.retryAutoProfile(role)}>重新识别</button>}
          {(busy || (state.phase === 'ready' && !state.accepted)) && <button type="button" onClick={() => session.cancelAutoProfile(role)}>取消</button>}
          <button type="button" className="ghost" onClick={() => {
            session.editAutoProfile(role)
            window.history.pushState(null, '', '/admin')
            window.dispatchEvent(new PopStateEvent('popstate'))
          }}>手动编辑</button>
          {state.candidate && <button type="button" className="ghost" onClick={() => void session.saveAutoProfile(role)}>另存为新预设</button>}
        </div>
      </section>
    })}
  </div>
}

function RoiPreview({ role, roi }: { role: SourceRole; roi: RoiRect }): React.ReactNode {
  const session = useSession()
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const draw = () => {
      const video = session.engine.element(role)
      if (video.readyState < 2) return
      canvas.width = 240
      canvas.height = Math.max(32, Math.min(120, 240 * video.videoHeight * roi.h / (video.videoWidth * roi.w)))
      try {
        context.drawImage(video, video.videoWidth * roi.x, video.videoHeight * roi.y,
          video.videoWidth * roi.w, video.videoHeight * roi.h, 0, 0, canvas.width, canvas.height)
      } catch { /* A source swap can briefly remove the decoded frame. */ }
    }
    draw()
    const timer = setInterval(draw, 500)
    return () => clearInterval(timer)
  }, [session, role, roi])
  return <canvas ref={ref} className="auto-profile-preview" role="img" aria-label={`${roleName(role)}倒计时区域预览`} />
}
