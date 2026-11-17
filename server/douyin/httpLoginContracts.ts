/** Private main-process HTTP login contract; credentials and tickets never enter player IPC. */
import type { BrowserCookie } from '../../electron/cookies'
import type { DouyinSigningSnapshot } from './signingMaterial'

export interface DouyinHttpQr {
  image: string
  expiresAt: number
}

export type DouyinHttpLoginStep =
  | { status: 'waiting' }
  | { status: 'scanned' }
  | { status: 'expired' }
  | { status: 'verification-required'; message: string }
  | { status: 'sms-sent'; cooldownSeconds: number }
  | { status: 'authenticated'; uid: string; cookies: BrowserCookie[]; snapshot: DouyinSigningSnapshot | null }

export interface DouyinHttpPhone {
  phone: string
  countryCode: string
}

/** The caller binds one instance to a single AbortSignal and disposes it on account transitions. */
export interface DouyinHttpLoginSession {
  initialize(): Promise<DouyinHttpQr>
  refreshQr(): Promise<DouyinHttpQr>
  poll(): Promise<DouyinHttpLoginStep>
  sendSms(input: DouyinHttpPhone): Promise<DouyinHttpLoginStep>
  loginSms(input: DouyinHttpPhone & { code: string }): Promise<DouyinHttpLoginStep>
  loginPassword(input: { username: string; password: string }): Promise<DouyinHttpLoginStep>
  dispose(): void
}
