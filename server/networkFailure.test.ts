import { describe, expect, it } from 'vitest'
import { classifyFfmpegStderr, classifyNetworkFailure, StreamFailureError, streamFailureForCode, streamFailureHint } from './networkFailure'

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
  it.each([
    ['dns-failed', 'connect', 'dns-failed'],
    ['upstream-failed', 'connect', 'upstream-request-failed'],
    ['too-many-redirects', 'http', 'redirect-limit'],
    ['invalid-url', 'resolve', 'invalid-url'],
    ['bad-scheme', 'resolve', 'bad-scheme'],
    ['bad-port', 'resolve', 'bad-port'],
    ['host-not-allowed', 'resolve', 'host-not-allowed'],
  ])('classifies ProxyError reason %s independently of its private detail', (reason, stage, code) => {
    const result = classifyNetworkFailure({ name: 'ProxyError', reason, status: 403,
      message: 'PRIVATE https://signed.invalid/?token=PRIVATE Cookie=PRIVATE' })
    expect(result).toMatchObject({ stage, code })
    expect(result.message).not.toBe('目标地址未通过安全检查.')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|signed\.invalid|token=|Cookie/)
  })
  it.each([
    ['Invalid data found when processing input https://signed.invalid/?token=PRIVATE', 'media-format-invalid'],
    ['moov atom not found: Cookie=PRIVATE', 'media-format-invalid'],
    ['Unknown decoder private-codec', 'media-codec-unsupported'],
    ['Could not find codec parameters for stream 0', 'media-codec-unsupported'],
  ])('classifies media format diagnostics without forwarding source text', (text, code) => {
    expect(classifyFfmpegStderr(text)).toMatchObject({ stage: 'playback-not-ready', code })
    expect(JSON.stringify(classifyFfmpegStderr(text))).not.toMatch(/PRIVATE|signed\.invalid|private-codec|token=|Cookie/)
  })
  it('does not mislabel a generic input-opening failure as invalid media', () => {
    expect(classifyFfmpegStderr('Error opening input: Immediate exit requested')).toBeUndefined()
  })
  it('reconstructs only recognized public failures and their actionable hints', () => {
    expect(streamFailureForCode('http-503')).toEqual({ stage: 'http', code: 'http-503', status: 503, message: '服务器返回 HTTP 503.' })
    expect(streamFailureForCode('http-407')).toMatchObject({ stage: 'proxy', code: 'proxy-rejected' })
    expect(streamFailureHint('dns-failed')).toContain('DNS')
    expect(streamFailureHint('proxy-unreachable')).toContain('代理')
    expect(streamFailureHint('tls-certificate')).toContain('证书')
    expect(streamFailureForCode('http-200')).toBeUndefined()
    expect(streamFailureForCode('toString')).toBeUndefined()
    expect(streamFailureForCode('PRIVATE https://signed.invalid')).toBeUndefined()
  })
})
