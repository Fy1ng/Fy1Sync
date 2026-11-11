import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { EmbeddedLoginState, EmbeddedLoginViewport } from '../../../electron/embeddedLoginContracts'
import { Icon } from '../kit'
import { refreshLoginStatus } from './status'
import './embeddedLogin.css'

const PLATFORM_NAME = { douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙', douyin: '抖音' } as const

function validState(state: EmbeddedLoginState | null): boolean {
  return state === null || Boolean(state && typeof state.id === 'string' && state.id
    && Object.hasOwn(PLATFORM_NAME, state.platform) && ['login', 'website'].includes(state.purpose)
    && ['loading', 'ready', 'verifying', 'challenge', 'failed'].includes(state.phase))
}

/** Subscribe before querying, and never let an older snapshot replace a live event. */
export function useEmbeddedLoginState(): EmbeddedLoginState | null {
  const [state, setState] = useState<EmbeddedLoginState | null>(null)
  useEffect(() => {
    let live = true
    let revision = 0
    let current: EmbeddedLoginState | null = null
    const release = apiClient.subscribeEmbeddedLogin((next) => {
      if (!live || !validState(next)) return
      revision += 1
      if (current?.purpose === 'login' && (!next || next.id !== current.id)) void refreshLoginStatus()
      current = next
      setState(next)
    })
    const queriedAt = revision
    void apiClient.getEmbeddedLogin().then((result) => {
      if (!live || revision !== queriedAt || !result.ok || !validState(result.value)) return
      current = result.value
      setState(result.value)
    }).catch(() => {})
    return () => { live = false; release() }
  }, [])
  return state
}

function hiddenViewport(id: string): EmbeddedLoginViewport {
  return { id, visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } }
}

export function EmbeddedLoginOverlay({ state }: { state: EmbeddedLoginState | null }): React.ReactNode {
  return state ? <LoginCard key={state.id} state={state} /> : null
}

function LoginCard({ state }: { state: EmbeddedLoginState }): React.ReactNode {
  const dialog = useRef<HTMLDialogElement | null>(null)
  const host = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(false)
  const pending = useRef(false)
  const [action, setAction] = useState<'close' | 'retry' | 'back' | null>(null)
  const [error, setError] = useState('')
  const website = state.purpose === 'website'
  const title = `${PLATFORM_NAME[state.platform]}${website ? '网页' : '登录'}`
  const captcha = state.presentation === 'captcha'
  const official = state.presentation === 'official' || (state.phase === 'challenge' && !captcha)
  const nativeVisible = ['ready', 'verifying', 'challenge'].includes(state.phase) && action !== 'close'

  useLayoutEffect(() => {
    const node = dialog.current
    if (!node) return
    mounted.current = true
    if (typeof node.showModal === 'function') {
      if (!node.open) node.showModal()
      node.focus({ preventScroll: true })
    } else node.setAttribute('open', '')
    return () => {
      mounted.current = false
      if (node.open && typeof node.close === 'function') node.close()
    }
  }, [])

  useLayoutEffect(() => {
    const node = host.current
    if (!node) return
    let live = true
    let frame: number | null = null
    let last = ''
    const send = (viewport: EmbeddedLoginViewport): void => {
      const signature = JSON.stringify(viewport)
      if (signature === last) return
      last = signature
      void apiClient.setEmbeddedLoginViewport(viewport).then((result) => {
        if (live && mounted.current && !result.ok) setError(result.message)
      }).catch(() => { if (live && mounted.current) setError('登录页面暂时无法显示, 请重试.') })
    }
    const measure = (): void => {
      frame = null
      if (!live) return
      const bounds = node.getBoundingClientRect()
      const x = Math.max(0, Math.ceil(bounds.left))
      const y = Math.max(0, Math.ceil(bounds.top))
      const width = Math.max(0, Math.floor(Math.min(window.innerWidth, bounds.right)) - x)
      const height = Math.max(0, Math.floor(Math.min(window.innerHeight, bounds.bottom)) - y)
      send({ id: state.id, rect: { x, y, width, height },
        visible: nativeVisible && !document.hidden && width > 0 && height > 0 })
    }
    const schedule = (): void => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(node)
    if (dialog.current) observer?.observe(dialog.current)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    document.addEventListener('visibilitychange', measure)
    measure()
    return () => {
      live = false
      if (frame !== null) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      document.removeEventListener('visibilitychange', measure)
      void apiClient.setEmbeddedLoginViewport(hiddenViewport(state.id)).catch(() => {})
    }
  }, [state.id, nativeVisible])

  const act = useCallback(async (next: 'close' | 'retry' | 'back'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setAction(next)
    setError('')
    try {
      const result = next === 'close' ? await apiClient.cancelEmbeddedLogin(state.id)
        : next === 'back' ? await apiClient.backEmbeddedLogin(state.id) : await apiClient.retryEmbeddedLogin(state.id)
      if (mounted.current && !result.ok) setError(result.message)
    } catch {
      if (mounted.current) setError(next === 'close' ? '暂时无法关闭, 请重试.' : next === 'back' ? '暂时无法返回登录, 请重试.' : '重试失败, 请稍后再试.')
    } finally {
      pending.current = false
      if (mounted.current) setAction(null)
    }
  }, [state.id])

  // Capture before the player and other dialogs. Native-page Escape is handled in main.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void act('close')
      } else event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [act])

  return (
    <dialog ref={dialog} className={`embedded-login-card${website ? ' is-website' : ''}${captcha ? ' is-captcha' : ''}`}
      tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} closedby="none"
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); void act('close') }}>
      <header className="embedded-login-head">
        <div>
          <h2>{captcha ? (state.platform === 'douyin' ? '安全验证' : '人机验证') : title}</h2>
          <p>{captcha ? '完成后返回登录' : state.accountLabel ?? (website ? '在当前窗口完成网页操作' : '在当前窗口完成官方账号登录')}</p>
        </div>
        <button type="button" className="icon-btn" disabled={action !== null} aria-label={`关闭${title}`}
          onClick={() => void act('close')}><Icon name="close" /></button>
      </header>
      <div className="embedded-login-host" ref={host} data-testid="embedded-login-host" aria-busy={state.phase === 'loading'}>
        {state.phase === 'loading' && (website
          ? <div className="embedded-login-wait" role="status"><span className="embedded-login-spinner" />正在打开官方网页</div>
          : <div className="embedded-login-placeholder" role="status" aria-label="正在加载官方登录页面">
            <div className="embedded-login-scan"><span className="embedded-login-spinner" /><h3>扫码登录</h3><p>正在加载官方二维码</p></div>
            <div className="embedded-login-input"><h3>短信 / 密码登录</h3><div className="embedded-login-skeleton" /><div className="embedded-login-skeleton" /><div className="embedded-login-skeleton is-button" /><p>正在准备统一登录表单</p></div>
          </div>)}
        {state.phase === 'failed' && <div className="embedded-login-wait" role="alert">
          <Icon name="refresh" /><h3>{website ? '网页暂时无法打开' : '登录页面暂时无法加载'}</h3>
          <p>{state.message ?? '请检查网络连接后重试.'}</p>
          <button type="button" className="btn-solid small" disabled={action !== null} onClick={() => void act('retry')}>重试</button>
        </div>}
      </div>
      <footer className="embedded-login-footer">
        <p role={error ? 'alert' : 'status'}>{error || (action === 'close' ? '正在关闭' : captcha ? '完成后返回登录' : state.phase === 'failed' ? '可重试或关闭此页面' : state.message || (official || state.presentation === 'verification' ? '完成安全验证后将继续登录' : state.phase === 'verifying' ? '正在确认登录状态, 请稍候' : state.phase === 'loading' ? '正在准备登录页面' : website ? '完成后可关闭此页面' : '请使用扫码, 短信或密码登录, 完成后将自动关闭')) }</p>
        {(official || captcha) && !website && <button type="button" className="embedded-login-back" disabled={action !== null}
          onClick={() => void act('back')}>{captcha ? '返回登录' : '返回统一登录'}</button>}
        <span>Esc 关闭</span>
      </footer>
    </dialog>
  )
}
