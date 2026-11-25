import type { LoginPlatform } from '../../electron/cookies'

export const LOGIN_STATE_CHANGED_EVENT = 'fy1sync:login-state-changed'

export interface LoginStateChange {
  platforms?: readonly LoginPlatform[]
  action?: 'login' | 'import' | 'logout' | 'account'
}

export function notifyLoginStateChanged(platforms?: readonly LoginPlatform[], action?: LoginStateChange['action']): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<LoginStateChange>(LOGIN_STATE_CHANGED_EVENT, {
    detail: { ...(platforms ? { platforms: [...platforms] } : {}), ...(action ? { action } : {}) },
  }))
}

export function subscribeLoginStateChanged(listener: (change: LoginStateChange) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<LoginStateChange | undefined>).detail
    listener(detail && typeof detail === 'object' ? detail : {})
  }
  window.addEventListener(LOGIN_STATE_CHANGED_EVENT, handler)
  return () => window.removeEventListener(LOGIN_STATE_CHANGED_EVENT, handler)
}
