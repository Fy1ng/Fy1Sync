import { useCallback, useEffect, useRef, useState } from 'react'
import { apiClient } from '../../app/apiClient'
import type { LoginStatus } from '../../../electron/login'
import { useRemembered } from '../../app/remembered'
import { refreshLoginStatus } from './status'
import { AccountAvatar, BrowserImportButton } from './BrowserLoginImport'
import { ErrorText, useErrorState } from '../../ui/ErrorDetails'
import { displayError } from '../../core/errorDetails'
import { subscribeLoginStateChanged } from '../../core/loginEvents'
import { ReadError } from '../ReadError'
import { InlineConfirm } from '../InlineConfirm'

const NAME = { bilibili: '哔哩哔哩', huya: '虎牙' } as const

/** These platforms each keep one account; Douyu's existing account desk stays separate. */
export function PlatformAccount({ platform }: { platform: 'bilibili' | 'huya' }): React.ReactNode {
  const [status, setStatus] = useRemembered<LoginStatus | null>('login-status', null)
  const [loadError, setLoadError, loadErrorDetail] = useErrorState()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError, errorDetail] = useErrorState()
  const mounted = useRef(false)
  const pending = useRef(false)
  const readRevision = useRef(0)
  const previousStatus = useRef(status)
  const refresh = useCallback(async (): Promise<void> => {
    const started = ++readRevision.current
    if (mounted.current) setLoadError('')
    let failed = false
    const next = await refreshLoginStatus((message, detail) => {
      failed = true
      if (mounted.current && started === readRevision.current) setLoadError({ message, detail })
    })
    if (!mounted.current || started !== readRevision.current) return
    if (next?.[platform]) { setStatus(next); setLoadError('') }
    else if (!failed) setLoadError('账号状态读取失败，请重试')
  }, [platform, setStatus, setLoadError])
  useEffect(() => {
    if (status !== previousStatus.current) {
      previousStatus.current = status
      if (status?.[platform]) setLoadError('')
    }
  }, [platform, status, setLoadError])
  useEffect(() => {
    mounted.current = true
    void refresh()
    let active = false
    let refreshQueued = false
    const scheduleRefresh = (): void => {
      if (pending.current || refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!mounted.current || pending.current) return
        setError('')
        setMessage('')
        void refresh()
      })
    }
    const release = apiClient.subscribeEmbeddedLogin((state) => {
      if (active && (!state || state.platform !== platform || state.purpose !== 'login') && !pending.current) void refresh()
      active = state?.platform === platform && state.purpose === 'login'
    })
    const releaseLogin = subscribeLoginStateChanged(({ platforms }) => {
      if (!platforms || platforms.includes(platform)) scheduleRefresh()
    })
    return () => { mounted.current = false; release(); releaseLogin() }
  }, [platform, refresh, setError])

  const act = async (logout: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setMessage(logout ? '' : '请在当前窗口完成登录')
    try {
      const result = logout ? await apiClient.logout(platform) : await apiClient.login(platform)
      if (mounted.current) {
        if (result.ok || result.code === 'login-cancelled') setMessage(result.ok ? (logout ? '已退出' : '已登录，重新载入直播间后生效') : '已取消登录')
        else { setMessage(''); setError(result) }
      }
      // The remembered status must update even after this page has unmounted.
      await refresh()
    } catch (error) {
      if (mounted.current) { setMessage(''); setError(displayError(error, '账号操作暂时失败，请重试')) }
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
        <span className="account-identity">{account?.nickname && <AccountAvatar username={account.nickname} avatar={account.avatar} />}
          {loadError ? '登录状态读取失败' : status === null ? '正在检查登录状态' : account?.loggedIn ? '已登录' : '未登录'}
          {account?.nickname && <span className="muted"> - {account.nickname}</span>}
        </span>
        <span className="row-end">
          <BrowserImportButton platform={platform} disabled={busy} />
          {account?.cookieCount ? <InlineConfirm label="退出" confirmLabel="确认退出" disabled={busy} danger={false} onConfirm={() => act(true)} /> : null}
          <button type="button" className="btn-solid small" disabled={busy} onClick={() => void act(false)}>{account?.loggedIn ? '重新登录' : '登录'}</button>
        </span>
      </div>
      <p className="muted">登录后需重新载入直播间，才能使用账号画质</p>
      {message && <p className="muted" role="status">{message}</p>}
      {loadError && <ReadError error={loadError} detail={loadErrorDetail} onRetry={() => void refresh()} />}
      {error && <p className="form-error" role="alert"><ErrorText error={errorDetail ?? error} message={error} /></p>}
    </section>
  )
}
