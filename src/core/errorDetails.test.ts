import { describe, expect, it } from 'vitest'
import { displayError, errorDetails, ERROR_DETAIL_LIMITS, hasAdditionalErrorDetails } from './errorDetails'

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
  it.each([
    '内容不能为空',
    { message: '内容不能为空' },
    { ok: false, message: ' 内容不能为空 ', detail: { message: '内容不能为空', optional: null, items: [], token: 'secret-value' } },
    { detail: { message: '内容不能为空' } },
    undefined,
  ])('does not treat a repeated summary or unusable fields as diagnostics: %j', value => {
    expect(hasAdditionalErrorDetails(errorDetails(value), '内容不能为空')).toBe(false)
  })
  it.each([
    { message: '读取失败', code: 'READ_FAILED' },
    { message: '读取失败', detail: { status: 429 } },
    { message: '读取失败', stage: 'download' },
    { message: '读取失败', cause: { message: 'ECONNREFUSED' } },
    { message: 'fetch failed' },
    { ok: true, value: {} },
  ])('recognizes fields or lower-level text not already visible: %j', value => {
    expect(hasAdditionalErrorDetails(errorDetails(value), '读取失败')).toBe(true)
  })
  it('does not count redaction itself as a difference from the visible summary', () => {
    const message = 'Cookie: sid=sample'
    expect(hasAdditionalErrorDetails(errorDetails({ message }), message)).toBe(false)
  })
})
