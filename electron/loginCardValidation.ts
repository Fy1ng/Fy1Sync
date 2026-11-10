import type { LoginCardAction, LoginPageSnapshot } from './loginCardContracts'

const fields = (input: Record<string, unknown>, names: readonly string[]) => Object.keys(input).length === names.length && names.every(name => Object.hasOwn(input, name))
const safeText = (value: unknown, min: number, max: number): value is string => typeof value === 'string'
  && value.length >= min && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const code = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{4,10}$/.test(value)

/** Secrets are validated once at the owner boundary and never placed in an error object. */
export function parseLoginCardAction(value: unknown): LoginCardAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.kind !== 'string') return null
  if (['second-send', 'refresh-qr', 'official', 'back', 'cancel'].includes(input.kind)) return fields(input, ['kind']) ? input as LoginCardAction : null
  if (input.kind === 'mode') return fields(input, ['kind', 'mode']) && typeof input.mode === 'string' && ['password', 'sms'].includes(input.mode) ? input as LoginCardAction : null
  if (input.kind === 'password') return fields(input, ['kind', 'username', 'password', 'accepted']) && input.accepted === true
    && safeText(input.username, 1, 160) && safeText(input.password, 1, 512) ? input as LoginCardAction : null
  if (input.kind === 'second-submit') return fields(input, ['kind', 'code']) && code(input.code) ? input as LoginCardAction : null
  if (input.kind !== 'prepare-sms' && input.kind !== 'send-sms' && input.kind !== 'sms') return null
  return fields(input, input.kind === 'sms' ? ['kind', 'phone', 'countryCode', 'code', 'accepted'] : ['kind', 'phone', 'countryCode', 'accepted'])
    && input.accepted === true && typeof input.phone === 'string' && /^[0-9]{5,16}$/.test(input.phone)
    && typeof input.countryCode === 'string' && /^\+?[1-9][0-9]{0,3}$/.test(input.countryCode)
    && (input.kind !== 'sms' || code(input.code)) ? input as LoginCardAction : null
}

/** All DOM output is untrusted, including snapshots from an official website. */
export function parseLoginPageSnapshot(value: unknown): LoginPageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.page !== 'string' || !['loading', 'form', 'second-factor', 'challenge', 'unknown'].includes(input.page)) return null
  const result: LoginPageSnapshot = { page: input.page as LoginPageSnapshot['page'] }
  if (input.page === 'loading' && input.submissionPending === true) result.submissionPending = true
  if ((input.page === 'loading' || input.page === 'challenge') && typeof input.nativeVerification === 'boolean') result.nativeVerification = input.nativeVerification
  if (typeof input.challengePhase === 'string' && ['loading', 'verifying', 'passed', 'interactive', 'unknown'].includes(input.challengePhase)) {
    result.challengePhase = input.challengePhase as LoginPageSnapshot['challengePhase']
  }
  if (input.page === 'second-factor' && input.verificationCompleted === true) result.verificationCompleted = true
  if (input.mode === 'password' || input.mode === 'sms') result.mode = input.mode
  if (typeof input.qrStatus === 'string' && ['loading', 'ready', 'scanned', 'expired', 'unavailable', 'paused'].includes(input.qrStatus)) result.qrStatus = input.qrStatus as LoginPageSnapshot['qrStatus']
  if (input.sms && typeof input.sms === 'object' && !Array.isArray(input.sms)) {
    const sms = input.sms as Record<string, unknown>
    if (typeof sms.canSend === 'boolean' && (sms.cooldownSeconds === null || typeof sms.cooldownSeconds === 'number'
      && Number.isInteger(sms.cooldownSeconds) && sms.cooldownSeconds >= 0 && sms.cooldownSeconds <= 3600)) {
      result.sms = { canSend: sms.canSend && (sms.cooldownSeconds === null || sms.cooldownSeconds === 0), cooldownSeconds: sms.cooldownSeconds as number | null }
    }
  }
  if (input.challenge && typeof input.challenge === 'object' && !Array.isArray(input.challenge)) {
    const region = input.challenge as Record<string, unknown>
    if (['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && (region[key] as number) >= 0 && (region[key] as number) <= 8192)
      && (region.width as number) >= 64 && (region.height as number) >= 40 && (region.width as number) <= 1600 && (region.height as number) <= 1400) {
      result.challenge = { x: region.x as number, y: region.y as number, width: region.width as number, height: region.height as number }
    }
  }
  if (typeof input.error === 'string' && ['invalid-credentials', 'invalid-code', 'rate-limited', 'network', 'unknown'].includes(input.error)) result.error = input.error as LoginPageSnapshot['error']
  if (input.verification && typeof input.verification === 'object') {
    const verification = input.verification as Record<string, unknown>
    if (verification.kind === 'sms' || verification.kind === 'email') {
      result.verification = { kind: verification.kind }
      if (safeText(verification.maskedTarget, 3, 100) && /\*{3,}/.test(verification.maskedTarget)
        && !/\d{7,}/.test(verification.maskedTarget)
        && (verification.kind === 'sms' ? /^\+?[0-9]{0,5}\*{3,}[0-9]{0,4}$/.test(verification.maskedTarget.replace(/ /g, ''))
          : /^[A-Za-z0-9._+-]{0,4}\*{3,}[A-Za-z0-9._+-]{0,3}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(verification.maskedTarget))) result.verification.maskedTarget = verification.maskedTarget
    }
  }
  if (input.qr && typeof input.qr === 'object') {
    const qr = input.qr as Record<string, unknown>
    result.qr = {}
    if (safeText(qr.src, 1, 512_000) && (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(qr.src) || qr.src.startsWith('https://'))) result.qr.src = qr.src
    if (qr.rect && typeof qr.rect === 'object') {
      const rect = qr.rect as Record<string, unknown>
      if (['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && (rect[key] as number) >= 0 && (rect[key] as number) <= 4096)) {
        result.qr.rect = { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }
      }
    }
  }
  return result
}
