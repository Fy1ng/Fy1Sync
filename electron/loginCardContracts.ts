import type { EmbeddedLoginPlatform } from './embeddedLoginContracts'

export type LoginCardMode = 'password' | 'sms'
export type LoginCardStage = 'loading' | 'form' | 'submitting' | 'verification' | 'official' | 'checking' | 'failed'
export type LoginQrStatus = 'loading' | 'ready' | 'scanned' | 'expired' | 'unavailable' | 'paused'

/** Sensitive inputs exist only in the dedicated local card and its owner-scoped action. */
export type LoginCardAction =
  | { kind: 'mode'; mode: LoginCardMode }
  | { kind: 'password'; username: string; password: string; accepted: true }
  | { kind: 'prepare-sms'; phone: string; countryCode: string; accepted: true }
  | { kind: 'send-sms'; phone: string; countryCode: string; accepted: true }
  | { kind: 'sms'; phone: string; countryCode: string; code: string; accepted: true }
  | { kind: 'second-send' }
  | { kind: 'second-submit'; code: string }
  | { kind: 'refresh-qr' }
  | { kind: 'official' }
  | { kind: 'back' }
  | { kind: 'cancel' }

export interface LoginVerification {
  kind: 'sms' | 'email'
  maskedTarget?: string
}

/** A direct snapshot of the official send control, never a locally synthesized deadline. */
export interface LoginSmsState {
  canSend: boolean
  cooldownSeconds: number | null
}

/** Geometry of the original challenge within its document, not a copied captcha. */
export interface LoginChallengeRegion {
  x: number
  y: number
  width: number
  height: number
}

/** This state is private to the local login view, never broadcast to the main renderer. */
export interface LoginCardState {
  platform: EmbeddedLoginPlatform
  stage: LoginCardStage
  mode: LoginCardMode
  qr: { status: LoginQrStatus; image?: string }
  sms: LoginSmsState
  busy: boolean
  message?: string
  verification?: LoginVerification
}

export interface LoginCardResult { ok: boolean; message?: string }
export interface LoginCardBridge {
  state(): Promise<LoginCardState | null>
  act(action: LoginCardAction): Promise<LoginCardResult>
  subscribe(listener: (state: LoginCardState) => void): () => void
}

declare global {
  interface Window { loginCard?: LoginCardBridge }
}

/** Official DOM adapters return classifications and bounded public geometry, never input values. */
export interface LoginPageSnapshot {
  page: 'loading' | 'form' | 'second-factor' | 'challenge' | 'unknown'
  /** The recognized official submit control is waiting; this is not page initialization. */
  submissionPending?: true
  /** The original account verification panel must finish before accepting an identity. */
  nativeVerification?: boolean
  /** SDK presentation only. A passed captcha is never an authenticated account. */
  challengePhase?: 'loading' | 'verifying' | 'passed' | 'interactive' | 'unknown'
  /** Official second-factor completion permits, but cannot replace, server identity verification. */
  verificationCompleted?: true
  mode?: LoginCardMode
  qr?: { src?: string; rect?: { x: number; y: number; width: number; height: number } }
  qrStatus?: LoginQrStatus
  sms?: LoginSmsState
  challenge?: LoginChallengeRegion
  verification?: LoginVerification
  error?: 'invalid-credentials' | 'invalid-code' | 'rate-limited' | 'network' | 'unknown'
}

export interface LoginPageActionResult { ok: boolean; reason?: 'not-ready' | 'unsupported' | 'invalid-input' }
export interface LoginPageAdapter {
  entryUrl: string
  acceptsFrame(url: string): boolean
  /** Vendor documents may be inspected, but must never receive account actions. */
  acceptsChallengeFrame?(url: string): boolean
  challengeInspectScript?: string
  /** Pure fixed DOM inspection in an isolated world. */
  inspectScript: string
  /** Paint-only protection around the original challenge; never changes its events or layout. */
  presentationScript?(challengeOnly: boolean): string
  /** Fixed selectors fill official controls and trigger only the requested user action. */
  actionScript(action: LoginCardAction): string
  /** Only prepares the site's login component; no login or SMS submission is allowed. */
  prepareScript?: string
}
