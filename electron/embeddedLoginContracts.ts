import type { CookiesSetDetails } from 'electron'
import type { BrowserCookie } from './cookies'

export type EmbeddedLoginPlatform = 'douyu' | 'bilibili' | 'huya' | 'douyin'
export type EmbeddedLoginDestination = 'yuba' | `room:${string}` | `fish-act:${string}`
export type EmbeddedLoginPhase = 'loading' | 'ready' | 'verifying' | 'challenge' | 'failed'

/** Only presentation state crosses IPC; browser identity and credentials stay in main. */
export interface EmbeddedLoginState {
  id: string
  platform: EmbeddedLoginPlatform
  purpose: 'login' | 'website'
  phase: EmbeddedLoginPhase
  accountLabel?: string
  message?: string
  presentation?: 'form' | 'verification' | 'captcha' | 'official'
}

export interface EmbeddedLoginViewport {
  id: string
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
}

export interface EmbeddedLoginMethods {
  getEmbeddedLogin: { args: undefined; result: EmbeddedLoginState | null }
  setEmbeddedLoginViewport: { args: EmbeddedLoginViewport; result: { ok: true } }
  cancelEmbeddedLogin: { args: { id: string }; result: { ok: true } }
  retryEmbeddedLogin: { args: { id: string }; result: { ok: true } }
  backEmbeddedLogin: { args: { id: string }; result: { ok: true } }
}

export const EMBEDDED_LOGIN_METHODS = [
  'getEmbeddedLogin', 'setEmbeddedLoginViewport', 'cancelEmbeddedLogin', 'retryEmbeddedLogin', 'backEmbeddedLogin',
] as const satisfies readonly (keyof EmbeddedLoginMethods)[]

export interface LoginCookieSession {
  cookies: { set(details: CookiesSetDetails): Promise<void> }
}

/** An attempt is bound to its initiating account, even if the active account changes. */
export interface EmbeddedLoginRequest {
  platform: EmbeddedLoginPlatform
  signal: AbortSignal
  destination?: EmbeddedLoginDestination
  accountLabel?: string
  initializeSession?: (target: LoginCookieSession) => Promise<void>
}

export interface EmbeddedLoginDriver {
  login(request: EmbeddedLoginRequest): Promise<BrowserCookie[]>
}
