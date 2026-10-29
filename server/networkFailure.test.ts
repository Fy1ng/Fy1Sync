import { describe, expect, it } from 'vitest'
import { classifyFfmpegStderr, classifyNetworkFailure, StreamFailureError } from './networkFailure'

describe('sanitized stream failures', () => {
  it.each([
    [{ code: 'ECONNREFUSED' }, 'connect', 'connection-refused'],
    [{ cause: { code: 'ENOTFOUND' } }, 'connect', 'dns-failed'],
    [{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'connect', 'tls-certificate'],
    [{ statusCode: 407 }, 'proxy', 'proxy-rejected'],
    [{ status: 429 }, 'http', 'http-429'],
    [{ message: 'Server returned 404 https://private.invalid/?token=PRIVATE Cookie=PRIVATE' }, 'http', 'http-404'],
    [new Error('Cookie=PRIVATE https://private.invalid/?token=PRIVATE'), 'connect', 'connection-failed'],
  ])('classifies a fixed code and discards all source text', (error, stage, code) => {
    const result = classifyNetworkFailure(error)
    expect(result).toMatchObject({ stage, code })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private\.invalid|token=|Cookie/)
  })
  it.each(['resolve', 'proxy', 'connect', 'http', 'stall', 'playback-not-ready'] as const)('preserves the structured %s stage', stage => {
    const failure = classifyNetworkFailure(undefined, stage)
    expect(classifyNetworkFailure(new StreamFailureError(failure))).toEqual(failure)
  })
  it('ignores unrecognized FFmpeg diagnostics', () => {
    expect(classifyFfmpegStderr('Cookie=PRIVATE https://private.invalid/?token=PRIVATE')).toBeUndefined()
  })
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])('attributes %s to an explicitly selected proxy', code => {
    expect(classifyNetworkFailure({ cause: { code } }, 'proxy')).toMatchObject({ stage: 'proxy', code: 'proxy-unreachable' })
  })
  it('preserves nested certificate failures under a proxy wrapper', () => {
    expect(classifyNetworkFailure({ code: 'UND_ERR_PRX_TLS', cause: { code: 'CERT_HAS_EXPIRED' } }, 'proxy'))
      .toMatchObject({ stage: 'connect', code: 'tls-certificate' })
  })
  it.each([403, 407, 502])('recognizes undici CONNECT rejection %d from its static message format', status => {
    expect(classifyNetworkFailure(new TypeError('fetch failed', { cause: {
      code: 'UND_ERR_ABORTED', message: `Proxy response (${status}) !== 200 when HTTP Tunneling`,
    } }), 'proxy')).toMatchObject({ stage: 'proxy', code: 'proxy-rejected' })
  })
})
