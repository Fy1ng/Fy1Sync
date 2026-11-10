import { describe, expect, it } from 'vitest'
import { parseLoginCardAction, parseLoginPageSnapshot } from './loginCardValidation'

describe('private login-card action validation', () => {
  it.each([
    { kind: 'mode', mode: 'password' }, { kind: 'mode', mode: 'sms' },
    { kind: 'password', username: 'fixture-user', password: 'fixture-private', accepted: true },
    { kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true },
    { kind: 'sms', phone: '81234567', countryCode: '65', code: '123456', accepted: true },
    { kind: 'second-send' }, { kind: 'second-submit', code: '123456' }, { kind: 'refresh-qr' }, { kind: 'official' }, { kind: 'back' }, { kind: 'cancel' },
  ])('accepts only the supported exact shape for $kind', value => { expect(parseLoginCardAction(value)).toEqual(value) })

  it.each([
    null, [], {}, { kind: 'login' }, { kind: 'mode', mode: 'qr' }, { kind: 'mode', mode: ['sms'] },
    { kind: 'password', username: '', password: 'fixture', accepted: true },
    { kind: 'password', username: 'x'.repeat(161), password: 'fixture', accepted: true },
    { kind: 'password', username: 'fixture', password: 'x'.repeat(513), accepted: true },
    { kind: 'password', username: 'fixture\n', password: 'fixture', accepted: true },
    { kind: 'password', username: 'fixture', password: 'fixture', accepted: false },
    { kind: 'password', username: 'fixture', password: 'fixture' },
    { kind: 'password', username: 'fixture', password: 'fixture', accepted: true, url: 'https://untrusted.test/' },
    { kind: 'send-sms', phone: '1'.repeat(17), countryCode: '+86', accepted: true },
    { kind: 'send-sms', phone: '138 0000 0000', countryCode: '+86', accepted: true },
    { kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: false },
    { kind: 'send-sms', phone: '13800000000', countryCode: '+86', accepted: true, endpoint: 'https://untrusted.test/' },
    { kind: 'second-send', code: '123456' }, { kind: 'cancel', url: 'https://untrusted.test/' },
  ])('rejects invalid or excess fields without returning submitted data (%j)', value => { expect(parseLoginCardAction(value)).toBeNull() })

  it.each(['', '123', '12345678901', '12 3456', '１２３４５６', '123456\n', '12ab34'])('rejects invalid OTP format %j for both basic and second-factor submission', code => {
    expect(parseLoginCardAction({ kind: 'second-submit', code })).toBeNull()
    expect(parseLoginCardAction({ kind: 'sms', phone: '13800000000', countryCode: '+86', code, accepted: true })).toBeNull()
  })
})

describe('untrusted official DOM snapshot validation', () => {
  it.each(['loading', 'challenge'])('preserves only the boolean native verification gate on %s', page => {
    expect(parseLoginPageSnapshot({ page, nativeVerification: true, code: 'synthetic-native-code', ticket: 'synthetic-native-ticket' }))
      .toEqual({ page, nativeVerification: true })
    expect(parseLoginPageSnapshot({ page, nativeVerification: false })).toEqual({ page, nativeVerification: false })
    for (const nativeVerification of [1, 'true', {}, [true]]) {
      expect(parseLoginPageSnapshot({ page, nativeVerification })).toEqual({ page })
    }
  })

  it.each(['form', 'second-factor', 'unknown'])('discards the native verification gate on %s', page => {
    expect(parseLoginPageSnapshot({ page, nativeVerification: true })).toEqual({ page })
  })

  it('keeps bounded native panel geometry without native codes, tickets or completion claims', () => {
    expect(parseLoginPageSnapshot({ page: 'challenge', challengePhase: 'interactive', nativeVerification: true, qrStatus: 'paused',
      challenge: { x: 20, y: 30, width: 726, height: 483, ticket: 'synthetic-native-ticket' }, code: 'synthetic-native-code', verificationCompleted: true }))
      .toEqual({ page: 'challenge', challengePhase: 'interactive', nativeVerification: true, qrStatus: 'paused', challenge: { x: 20, y: 30, width: 726, height: 483 } })
  })

  it('keeps only exact challenge phases and a strict second-factor completion hint', () => {
    expect(parseLoginPageSnapshot({ page: 'loading', challengePhase: 'passed', verificationCompleted: true }))
      .toEqual({ page: 'loading', challengePhase: 'passed' })
    expect(parseLoginPageSnapshot({ page: 'second-factor', verificationCompleted: true, completionToken: 'secret' }))
      .toEqual({ page: 'second-factor', verificationCompleted: true })
    expect(parseLoginPageSnapshot({ page: 'second-factor', verificationCompleted: 'true', challengePhase: ['passed'] }))
      .toEqual({ page: 'second-factor' })
  })
  it('returns a new reduced shape instead of input values, cookies, endpoints or extra DOM fields', () => {
    const result = parseLoginPageSnapshot({ page: 'form', mode: 'password', qrStatus: 'unavailable', password: 'fixture-private', cookie: 'fixture-cookie',
      url: 'https://untrusted.test/', token: 'fixture-token', verification: { kind: 'sms', maskedTarget: '138****0000', phone: '13800000000', code: '123456' } })
    expect(result).toEqual({ page: 'form', mode: 'password', qrStatus: 'unavailable', verification: { kind: 'sms', maskedTarget: '138****0000' } })
    expect(JSON.stringify(result)).not.toMatch(/fixture-private|fixture-cookie|fixture-token|13800000000|123456|untrusted/)
  })

  it.each(['invalid-credentials', 'invalid-code', 'rate-limited', 'network', 'unknown'])('keeps only fixed error category %s', error => {
    expect(parseLoginPageSnapshot({ page: 'form', error })).toEqual({ page: 'form', error })
  })

  it('drops array values that coerce to known optional error and QR-state enums', () => {
    expect(parseLoginPageSnapshot({ page: 'form', error: ['network'], qrStatus: ['ready'] })).toEqual({ page: 'form' })
  })

  it('discards arbitrary upstream error text and oversized or unmasked verification destinations', () => {
    expect(parseLoginPageSnapshot({ page: 'second-factor', error: 'Cookie=fixture-private', verification: { kind: 'sms', maskedTarget: '13800000000' } }))
      .toEqual({ page: 'second-factor', verification: { kind: 'sms' } })
    expect(parseLoginPageSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget: '**' + 'x'.repeat(100) } }))
      .toEqual({ page: 'second-factor', verification: { kind: 'sms' } })
  })
  it('accepts only a boolean pending-submit marker on a loading snapshot', () => {
    expect(parseLoginPageSnapshot({ page: 'loading', submissionPending: true })).toEqual({ page: 'loading', submissionPending: true })
    for (const submissionPending of [false, 1, 'true', {}, ['true']]) {
      expect(parseLoginPageSnapshot({ page: 'loading', submissionPending })).toEqual({ page: 'loading' })
    }
    expect(parseLoginPageSnapshot({ page: 'form', submissionPending: true })).toEqual({ page: 'form' })
  })

  it.each(['**13800000000', '13800000000**', '号码 13800000000 **'])('never returns a complete phone number disguised with masking markers: %s', maskedTarget => {
    const result = parseLoginPageSnapshot({ page: 'second-factor', verification: { kind: 'sms', maskedTarget } })
    expect(result?.verification).toEqual({ kind: 'sms' })
    expect(JSON.stringify(result)).not.toContain('13800000000')
  })

  it.each([null, [], {}, { page: 'authenticated' }, { page: ['form'] }])('rejects an invalid primary page classification %j', value => {
    expect(parseLoginPageSnapshot(value)).toBeNull()
  })

  it('bounds geometry and cooldown without preserving non-finite data', () => {
    expect(parseLoginPageSnapshot({ page: 'form', sms: { canSend: false, cooldownSeconds: 37 }, qr: { rect: { x: 10, y: 20, width: 160, height: 160, token: 'fixture-private' } } }))
      .toEqual({ page: 'form', sms: { canSend: false, cooldownSeconds: 37 }, qr: { rect: { x: 10, y: 20, width: 160, height: 160 } } })
    expect(parseLoginPageSnapshot({ page: 'form', sms: { canSend: false, cooldownSeconds: Number.NaN }, qr: { rect: { x: Infinity, y: 0, width: 160, height: 160 } } }))
      .toEqual({ page: 'form', qr: {} })
  })
})
