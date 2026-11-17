import { describe, expect, it, vi } from 'vitest'
import { diagnosticDetails } from './errorDetails'
import { httpErrorDetails } from './httpError'
import { classifyNetworkFailure, StreamFailureError, httpFailure } from './networkFailure'
import { sanitizedFailure } from './api'

describe('bounded original backend diagnostics', () => {
  it('retains original nested network codes through failure transport', () => {
    const original = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) })
    const failure = classifyNetworkFailure(original)
    const transported = classifyNetworkFailure(new StreamFailureError(failure))
    const result = sanitizedFailure({ ok: false, failure: { code: 'upstream-error', stage: transported.stage,
      reason: transported.code, message: transported.message, detail: transported.detail } })
    expect(result).toMatchObject({ ok: false, failure: { reason: 'dns-failed', detail: { message: 'fetch failed', cause: { code: 'EAI_AGAIN' } } } })
  })
  it('never evaluates nested exception accessors or proxy traps', () => {
    const trap = vi.fn(() => { throw new Error('must not execute') })
    const proxy = new Proxy({}, { ownKeys: trap, getPrototypeOf: trap, get: trap, getOwnPropertyDescriptor: trap })
    const value = Object.defineProperty({ cause: proxy }, 'code', { get: trap, enumerable: true })
    expect(diagnosticDetails(value)).toMatchObject({ cause: '[proxy omitted]', code: '[accessor omitted]' })
    expect(classifyNetworkFailure(value)).toMatchObject({ code: 'connection-failed' })
    expect(trap).not.toHaveBeenCalled()
  })
  it('redacts authentication, cookies, password, URLs and account sessions', () => {
    const value = { code: 'HTTP_429', message: 'retry https://user:pass@service.example/path?auth=URL_SECRET',
      cause: { message: 'Authorization: Bearer HEADER_SECRET', cookie: 'COOKIE_SECRET', password: 'PASSWORD_SECRET',
        authentication: 'AUTH_SECRET', session: { value: 'SESSION_SECRET' }, token: 'TOKEN_SECRET' },
      request: { headers: { Cookie: 'REQUEST_SECRET' } } }
    const json = JSON.stringify(diagnosticDetails(value))
    expect(json).toContain('HTTP_429')
    expect(json).not.toMatch(/URL_SECRET|HEADER_SECRET|COOKIE_SECRET|PASSWORD_SECRET|AUTH_SECRET|SESSION_SECRET|TOKEN_SECRET|REQUEST_SECRET|user:pass/)
  })
  it('bounds huge diagnostic values and cyclic causes', () => {
    const value: Record<string, unknown> = { message: 'x'.repeat(100_000) }
    value.cause = value
    expect(JSON.stringify(diagnosticDetails(value)).length).toBeLessThan(20_000)
    expect(diagnosticDetails(value).cause).toBe('[circular]')
  })
  it('omits the JSON parser body preview because it can include raw credentials', () => {
    let failure: unknown
    try { JSON.parse('AUTHENTICATION_SECRET') } catch (error) { failure = error }
    const detail = diagnosticDetails(failure)
    expect(detail).toMatchObject({ name: 'SyntaxError', message: 'Unexpected token [input omitted] is not valid JSON' })
    expect(JSON.stringify(detail)).not.toContain('AUTHENTICATION_SECRET')
  })
  it('carries HTTP 429 status, server message and retry hint through the public resolver result', async () => {
    const response = Response.json({ error: { code: 'ratelimited', info: 'Request limit exceeded', token: 'BODY_SECRET' },
      cookie: 'COOKIE_SECRET', data: { session: 'SESSION_SECRET' } }, { status: 429, statusText: 'Too Many Requests',
      headers: { 'retry-after': '30', 'set-cookie': 'secret=HEADER_SECRET' } })
    const detail = await httpErrorDetails(response)
    const failure = classifyNetworkFailure(new StreamFailureError(httpFailure(429, detail)))
    const result = sanitizedFailure({ ok: false, failure: { code: 'upstream-error', stage: failure.stage,
      reason: failure.code, message: failure.message, detail: failure.detail } })
    expect(result).toMatchObject({ ok: false, failure: { status: 429, detail: { status: 429, statusText: 'Too Many Requests',
      retryAfter: '30', upstream: { error: { code: 'ratelimited', info: 'Request limit exceeded' } } } } })
    expect(JSON.stringify(result)).not.toMatch(/BODY_SECRET|COOKIE_SECRET|SESSION_SECRET|HEADER_SECRET/)
  })
  it('retains a public rate-limit title without retaining the surrounding HTML or account fields', async () => {
    const detail = await httpErrorDetails(new Response('<title>Rate Limited - Liquipedia</title><input name="token" value="PRIVATE_TOKEN"><p>private account page</p>',
      { status: 429, headers: { 'content-type': 'text/html' } }))
    expect(detail).toMatchObject({ status: 429, contentType: 'text/html', upstream: { title: 'Rate Limited - Liquipedia' } })
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_TOKEN|private account|<input/)
  })
})
