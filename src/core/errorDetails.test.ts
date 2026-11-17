import { describe, expect, it } from 'vitest'
import { displayError, errorDetails, ERROR_DETAIL_LIMITS } from './errorDetails'

describe('local error details', () => {
  it('retains the original exception, network code and cause beside a public summary', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' })
    const value = displayError(new TypeError('fetch failed', { cause }), '网络连接失败')
    expect(value.message).toBe('网络连接失败')
    expect(value.detail).toMatchObject({ name: 'TypeError', message: 'fetch failed', cause: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED', syscall: 'connect' } })
  })
  it('removes authentication fields, URL secrets and session objects before display', () => {
    const value = errorDetails({ status: 429, message: 'GET https://alice:secret@example.com/api?token=abc&room=123 Bearer abc.def.ghi',
      responseBody: '{"token":"private-value","message":"Rate Limited"}', token: 'private-token', headers: { cookie: 'session-cookie' },
      config: { password: 'private-password' }, cause: { apiKey: 'private-key', message: 'Cookie: sid=private-cookie' } })
    const output = JSON.stringify(value)
    for (const secret of ['alice', 'secret@', 'abc.def.ghi', 'private-value', 'private-token', 'session-cookie', 'private-password', 'private-key', 'private-cookie', 'room=123']) expect(output).not.toContain(secret)
    expect(value.status).toBe(429)
    expect(output).toContain('Rate Limited')
  })
  it('does not invoke accessors or retain recursive and excessive data', () => {
    const value: Record<string, unknown> = { message: 'x'.repeat(50000) }
    Object.defineProperty(value, 'danger', { enumerable: true, get() { throw new Error('Getter executed') } })
    value.cause = value
    const detail = errorDetails(value)
    expect(detail.danger).toBe('[accessor omitted]')
    expect(detail.cause).toBe('[circular]')
    expect(String(detail.message).length).toBeLessThanOrEqual(ERROR_DETAIL_LIMITS.string)
    expect(() => JSON.stringify(errorDetails(new Proxy({}, { ownKeys() { throw new Error('blocked') } })))).not.toThrow()
  })
  it('redacts platform credentials and native JSON input previews in renderer errors', () => {
    const detail = errorDetails({ SESSDATA: 'session-value', privateKey: 'key-value', message: 'SESSDATA=inline-session; PRIVATE_COOKIE=inline-cookie; SAPISID=inline-auth',
      cause: new SyntaxError('Unexpected token \'P\', "PRIVATE secret response" is not valid JSON') })
    const serialized = JSON.stringify(detail)
    for (const value of ['session-value', 'key-value', 'inline-session', 'inline-cookie', 'inline-auth', 'PRIVATE secret']) expect(serialized).not.toContain(value)
    expect(serialized).toContain('SyntaxError')
  })
  it('retains native DOM exception fields when a browser operation is denied', () => {
    expect(errorDetails(new DOMException('User gesture required', 'NotAllowedError'))).toMatchObject({ name: 'NotAllowedError', message: 'User gesture required' })
  })
  it('keeps redaction stable as the same fields cross main and renderer boundaries', () => {
    const first = errorDetails({ message: 'Cookie=secret', cause: { message: 'token=secret' } })
    expect(errorDetails(errorDetails(first))).toEqual(first)
  })
})
