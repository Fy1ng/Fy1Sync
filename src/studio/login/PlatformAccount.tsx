import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { LoginStatus } from '../../../electron/login'
import { useRemembered } from '../../app/remembered'
import { refreshLoginStatus } from './status'

const NAME = { bilibili: '哔哩哔哩', huya: '虎牙' } as const

/** These platforms each keep one account; Douyu's existing account desk stays separate. */
export function PlatformAccount({ platform }: { platform: 'bilibili' | 'huya' }): React.ReactNode {
  const [status, setStatus] = useRemembered<LoginStatus | null>('login-status', null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(false)
  const pending = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    const next = await refreshLoginStatus((error) => { if (mounted.current) setMessage(error) })
    if (mounted.current && next) setStatus(next)
  }, [setStatus])
  useEffect(() => {
    mounted.current = true
    void refresh()
    let active = false
    const release = apiClient.subscribeEmbeddedLogin((state) => {
      if (active && (!state || state.platform !== platform || state.purpose !== 'login')) void refresh()
      active = state?.platform === platform && state.purpose === 'login'
    })
    return () => { mounted.current = false; release() }
  }, [platform, refresh])

  const act = async (logout: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage(logout ? '' : '请在当前窗口完成登录')
    try {
      const result = logout ? await apiClient.logout(platform) : await apiClient.login(platform)
      if (mounted.current) setMessage(result.ok ? (logout ? '已退出' : '已登录, 重新载入画面后生效') : result.code === 'login-cancelled' ? '已取消登录' : result.message)
      // The remembered status must update even after this page has unmounted.
      await refresh()
    } catch {
      if (mounted.current) setMessage('账号操作暂时失败, 请重试.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const account = status?.[platform]
  const name = NAME[platform]
  return (
    <section className="group" aria-label={`${name}账号`}>
      <h3>{name}账号</h3>
      <div className="row-split">
        <span>{status === null ? '正在检查登录状态' : account?.loggedIn ? '已登录' : '未登录'}
          {account?.nickname && <span className="muted"> - {account.nickname}</span>}
        </span>
        <span className="row-end">
          {account?.cookieCount ? <button type="button" className="btn-quiet small" disabled={busy} onClick={() => void act(true)}>退出</button> : null}
          <button type="button" className="btn-solid small" disabled={busy} onClick={() => void act(false)}>{account?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">使用扫码, 短信或密码登录. 登录后重新载入直播间, 以使用账号可用的画质.</p>
      {message && <p className="muted" role="status">{message}</p>}
    </section>
  )
}
