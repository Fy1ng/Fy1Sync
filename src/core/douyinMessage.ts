/** Plain text only. No paid messages, gifts, scheduling or automatic retries. */
export const DOUYIN_MESSAGE_LIMIT = 50
/** Emitted after login/logout IPC settles, after any replacement cookies have been saved. */
export const DOUYIN_LOGIN_CHANGED_EVENT = 'fy1sync:douyin-login-changed'

export function douyinMessageText(value: unknown): string | null {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f\ud800-\udfff]/u.test(value)) return null
  const text = value.trim()
  return text.length > 0 && text.length <= DOUYIN_MESSAGE_LIMIT ? text : null
}

export function douyinMessageRoom(value: unknown): value is string {
  return typeof value === 'string' && /^douyin:[1-9]\d{0,19}$/.test(value)
    && BigInt(value.slice(7)) <= 0xffff_ffff_ffff_ffffn
}

export interface DouyinSendState {
  loggedIn: boolean
  canSend: boolean
  loginState?: 'authenticated' | 'signed-out' | 'expired' | 'unavailable' | 'authenticating'
  /** Public account identity, never authentication material. */
  uid?: string
  nickname?: string
  message: string
  detail?: import('./errorDetails').ErrorDetails
}
export interface DouyinMessageInput { room: string; text: string; expectedUid: string }
export interface DouyinMessageOutcome {
  status: 'accepted' | 'waiting-user' | 'failed'
  message: string
  nextAllowedAt: number | null
  messageId?: string
  detail?: import('./errorDetails').ErrorDetails
  /** Fixed categories and bounded numeric codes only, never raw responses or tokens. */
  diagnostic?: {
    reason: 'verification-required' | 'rate-limited' | 'http-rejected' | 'platform-rejected' | 'invalid-receipt' | 'receipt-received'
    httpStatus: number
    platformCode?: number
    guardResultPresent?: true
    guardResult?: number
    guardSecurityResultPresent?: true
    guardSecurityResult?: number
  }
}
