/**
 * Admin token handling for the Profile Editor.
 *
 * Two rules shape this hook. First, the token is verified *server-side* before the
 * editor renders: a client-side comparison would be decoration, since the preset write
 * endpoints check the header themselves anyway. Second, a token that arrives in the URL
 * is moved out of it immediately — query strings land in history, in the window title,
 * and in any screenshot of the address bar. sessionStorage keeps it for this tab only
 * and drops it when the tab closes.
 */

import { useCallback, useEffect, useState } from 'react'
import { apiClient } from '../../app/apiClient'

const TOKEN_KEY = 'stream-sync.admin-token'

export type TokenPhase = 'checking' | 'locked' | 'unlocked'

export interface AdminTokenState {
  phase: TokenPhase
  /** Only set once `phase === 'unlocked'`; preset writes need it as a header. */
  token: string
  message: string
  submit: (candidate: string) => Promise<void>
  clear: () => void
}

function readStored(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    // Private mode or a storage-blocked context. The manual field still works.
    return ''
  }
}

function writeStored(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Non-fatal: the token lives in component state for this page view either way.
  }
}

/** Pull `?token=` out of the URL and rewrite the address without it. */
function takeTokenFromUrl(): string {
  const url = new URL(window.location.href)
  const fromQuery = url.searchParams.get('token')
  if (!fromQuery) return ''
  url.searchParams.delete('token')
  const search = url.searchParams.toString()
  window.history.replaceState(
    null,
    '',
    `${url.pathname}${search ? `?${search}` : ''}${url.hash}`,
  )
  return fromQuery
}

export function useAdminToken(): AdminTokenState {
  const [phase, setPhase] = useState<TokenPhase>('checking')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')

  const verify = useCallback(async (candidate: string): Promise<boolean> => {
    const result = await apiClient.verifyAdmin(candidate)
    if (result.ok) {
      setToken(candidate)
      writeStored(candidate)
      setPhase('unlocked')
      setMessage('')
      return true
    }
    setToken('')
    writeStored('')
    setPhase('locked')
    setMessage(result.message)
    return false
  }, [])

  useEffect(() => {
    let cancelled = false
    const candidate = takeTokenFromUrl() || readStored()
    if (!candidate) {
      setPhase('locked')
      return
    }
    void verify(candidate).then(() => {
      // The unmount case is handled by the guard rather than by aborting the request:
      // the answer is cheap and discarding it keeps this free of an AbortController.
      if (cancelled) return
    })
    return () => {
      cancelled = true
    }
  }, [verify])

  const submit = useCallback(
    async (candidate: string) => {
      const trimmed = candidate.trim()
      if (!trimmed) {
        setMessage('请输入管理令牌')
        return
      }
      setPhase('checking')
      await verify(trimmed)
    },
    [verify],
  )

  const clear = useCallback(() => {
    setToken('')
    writeStored('')
    setPhase('locked')
    setMessage('已退出编辑器')
  }, [])

  return { phase, token, message, submit, clear }
}
