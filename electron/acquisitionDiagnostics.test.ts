import { describe, expect, it, vi } from 'vitest'
import { AcquisitionDiagnostics } from './acquisitionDiagnostics'
import { DIAGNOSTIC_LIMITS, type AcquisitionDiagnosticReport } from './diagnosticContracts'
import { diagnosticCode, sanitizeDiagnosticReport } from './diagnosticSanitizer'
import { createDesktopService } from '../server/api'
import { resolveConfig } from '../server/config'
import { Acquisition } from './acquisition'
import { ToolError } from './toolLocator'
import type { ToolsStatus } from './toolsService'
import type { LoginStatus } from './cookies'

const secret = 'PRIVATE_SENTINEL_Account123'
const app: AcquisitionDiagnosticReport['app'] = { version: '0.3.0', electron: '44.9.3', node: '24.0.0', platform: 'win32', arch: 'x64', packaged: true }
const status: ToolsStatus = { tools: [
  { name: 'ffmpeg', source: 'bundled', version: 'n8.1.3-23-g5c4f5744cd-fy1sync.1', available: true },
  { name: 'ffprobe', source: 'bundled', version: 'n8.1.3', available: true },
  { name: 'yt-dlp', source: 'managed', version: '2026.10.26', available: true },
], provider: { available: true, source: 'bundled', version: '2.0.2' }, update: { phase: 'idle', downloadedBytes: 0, totalBytes: 0, message: '' }, externalYtdlp: false, fixturesAvailable: false, bundledAvailable: true }
const login = { youtube: { loggedIn: true, cookieCount: 42, authKeysPresent: [secret], expiresAt: 9999999999, hasSessionCookies: false },
  douyin: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false },
  douyu: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false } } satisfies LoginStatus
function fixture() {
  let now = 1793613600000
  const tools = { status: vi.fn(async () => structuredClone(status)) }
  const loginStatus = vi.fn(async () => structuredClone(login))
  const diagnostics = new AcquisitionDiagnostics({ app, tools, loginStatus, now: () => now++ })
  return { diagnostics, tools, loginStatus }
}

describe('bounded ordinary acquisition diagnostics', () => {
  it.each(['socks5', 'unsupported'] as const)('exports only the route category %s and never its proxy URI', route => {
    const report = sanitizeDiagnosticReport({ attempts: [{ id: 1, events: [{ stage: 'route', status: 'resolved', route,
      proxyUrl: 'socks5://PRIVATE:PRIVATE@127.0.0.1:1080', url: 'https://signed.invalid/?token=PRIVATE' }] }] })
    expect(report.attempts[0]?.events[0]?.route).toBe(route)
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|signed\.invalid|proxyUrl|socks5:\/\//)
  })
  it.each(['upstream-request-failed', 'media-format-invalid', 'media-codec-unsupported', 'credentials-cross-origin'] as const)('retains the fixed failure code %s without admitting source text', code => {
    expect(diagnosticCode(code)).toBe(code)
    expect(diagnosticCode(code + ' Cookie=PRIVATE https://signed.invalid/?token=PRIVATE')).toBe('unknown')
  })
  it('retains only whitelisted fields at collection and returns independent snapshots', async () => {
    const { diagnostics } = fixture()
    const attempt = diagnostics.begin('stream-' + secret)
    const event = { stage: 'adaptive', status: 'failed', code: 'http-403', extractionId: 2, client: 'web', route: 'http',
      Cookie: secret, token: secret, stderr: secret, url: 'https://media.invalid/?token=' + secret, path: 'C:/Users/' + secret,
      warnings: ['token-provider', secret], heights: [1440, 1080, secret, -1], providerConfigured: true, providerOutcome: 'warning',
      formats: { total: 3, protocols: { https: 3, [secret]: 42 }, videoCodecs: { vp9: 1 }, audioCodecs: { aac: 1 }, muxedHls: 0, adaptivePairs: 1, privateField: secret } }
    attempt.record(event)
    event.warnings.push('authentication')
    event.heights[0] = 2160
    attempt.finish('failed', { stage: 'resolve', status: 'failed', code: 'youtube-hls-missing', message: secret })
    const report = await diagnostics.report()
    expect(report.app).toEqual(app)
    expect(report.login).toEqual({ youtube: true, douyu: false })
    expect(report.attempts[0]).toMatchObject({ role: 'extra', status: 'failed', id: 1, endedAt: expect.any(Number) })
    expect(report.attempts[0]!.events[1]).toMatchObject({ stage: 'adaptive', client: 'web', route: 'http', code: 'http-403', warnings: ['token-provider'], heights: [1440, 1080] })
    expect(JSON.stringify(report)).not.toMatch(new RegExp(secret + '|https://|C:/|stderr|Cookie|authKeysPresent|url|path'))
    report.attempts[0]!.events.length = 0
    expect((await diagnostics.report()).attempts[0]!.events.length).toBeGreaterThan(0)
  })

  it('bounds attempts and events, and ignores events from completed or evicted attempts', async () => {
    const { diagnostics } = fixture()
    const oldest = diagnostics.begin('official')
    for (let n = 0; n < DIAGNOSTIC_LIMITS.maxAttempts; n++) diagnostics.begin('commentary').finish('failed')
    oldest.record({ stage: 'hls', status: 'resolved' })
    oldest.finish('resolved')
    const last = diagnostics.begin('official', 'reconnect')
    for (let n = 0; n < 100; n++) last.record({ stage: 'hls', status: 'started', extractionId: n })
    last.finish('failed')
    last.record({ stage: 'hls', status: 'resolved' })
    const report = await diagnostics.report()
    expect(report.attempts).toHaveLength(20)
    expect(new Set(report.attempts.map(attempt => attempt.id)).size).toBe(20)
    expect(report.droppedAttempts).toBe(2)
    expect(report.attempts.at(-1)).toMatchObject({ operation: 'reconnect', status: 'failed', droppedEvents: 38 })
    expect(report.attempts.at(-1)!.events).toHaveLength(64)
    expect(report.attempts.at(-1)!.events.at(-1)).toMatchObject({ stage: 'complete', status: 'failed' })
  })

  it('exports a report even if local tool inspection and login status both fail', async () => {
    const { diagnostics, tools, loginStatus } = fixture()
    tools.status.mockRejectedValue(new Error(secret))
    loginStatus.mockRejectedValue(new Error(secret))
    const report = await diagnostics.report()
    expect(report.tools).toMatchObject({ status: 'unavailable', provider: { available: null } })
    expect(report.login).toEqual({ youtube: null, douyu: null })
    expect(report.attempts).toEqual([])
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('coalesces concurrent report metadata reads and does not retain failed tool update details', async () => {
    const { diagnostics, tools } = fixture()
    tools.status.mockResolvedValue({ ...status, update: { phase: 'failed', message: secret }, provider: { ...status.provider, secret }, secret } as unknown as ToolsStatus)
    const [one, two] = await Promise.all([diagnostics.report(), diagnostics.report()])
    expect(tools.status).toHaveBeenCalledOnce()
    expect(one).toEqual(two)
    one.tools.items.length = 0
    expect(two.tools.items).toHaveLength(3)
    expect(JSON.stringify(two)).not.toContain(secret)
  })

  it('sanitizes malformed export input and only accepts fixed categories', () => {
    const value = sanitizeDiagnosticReport({ app: { version: secret, node: 'C:/' + secret, platform: secret },
      tools: { status: secret, items: [{ name: 'ffmpeg', version: secret, source: secret, path: secret }] }, login: { youtube: secret },
      attempts: [{ id: 1, startedAt: Infinity, endedAt: null, role: secret, operation: secret, status: secret,
        events: [{ stage: 'hls', status: 'failed', code: secret, warnings: [secret], route: secret, exitCode: secret }, { stage: secret, status: 'failed' }] }] })
    expect(value).toMatchObject({ app: { version: null, node: null, platform: 'unknown' }, login: { youtube: null },
      attempts: [{ events: [{ stage: 'hls', status: 'failed', code: 'unknown', warnings: [] }] }] })
    expect(JSON.stringify(value)).not.toContain(secret)
  })
})

describe('diagnostic service and acquisition integration', () => {
  function serviceFixture() {
    const { diagnostics } = fixture()
    const buffer = { subscribe: vi.fn(() => () => {}), start: vi.fn(), stop: vi.fn(async () => {}) }
    const runYtDlp = vi.fn<ConstructorParameters<typeof Acquisition>[0]['runYtDlp']>()
    const acquisition = new Acquisition({ buffer, diagnostics, runYtDlp, proxy: resolveConfig({}).proxy,
      logins: { login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(), cookieHeader: vi.fn() } })
    const service = createDesktopService({ dataDir: '.', proxy: resolveConfig({}).proxy, acquisition, diagnostics, registerMedia: () => '' })
    return { diagnostics, acquisition, service, buffer, runYtDlp }
  }
  it('keeps failures before playback URLs exist and preserves per-call diagnostic events without E2E hooks', async () => {
    const h = serviceFixture()
    h.runYtDlp.mockImplementation(async (_url, _adaptive, _network, diagnostic) => {
      diagnostic?.({ stage: 'hls', status: 'resolved', client: 'default', extractionId: 7, formats: {
        total: 0, protocols: { hls: 0, https: 0, dash: 0, other: 0 }, videoCodecs: { h264: 0, vp9: 0, av1: 0, none: 0, other: 0 },
        audioCodecs: { aac: 0, opus: 0, none: 0, other: 0 }, muxedHls: 0, adaptivePairs: 0,
      } })
      return { id: 'abcdefghijk', is_live: true, formats: [] }
    })
    expect(await h.service.invoke('resolve', { input: 'https://youtu.be/abcdefghijk', platform: 'youtube', role: 'official' }))
      .toMatchObject({ ok: true, value: { ok: false, failure: { reason: 'youtube-formats-empty' } } })
    const report = await h.service.invoke('getAcquisitionDiagnostics', undefined)
    expect(report).toMatchObject({ ok: true, value: { attempts: [{ status: 'failed', events: expect.arrayContaining([
      expect.objectContaining({ stage: 'hls', extractionId: 7, client: 'default' }),
      expect.objectContaining({ stage: 'resolve', code: 'youtube-formats-empty' }),
    ]) }] } })
    expect(h.buffer.start).not.toHaveBeenCalled()
    expect(JSON.stringify(report)).not.toContain('abcdefghijk')
    h.service.dispose(); h.acquisition.dispose()
  })

  it('records tools failing before the extractor is launched and still allows an empty-argument export', async () => {
    const { diagnostics } = fixture()
    const acquisition = new Acquisition({ diagnostics, proxy: resolveConfig({}).proxy,
      buffer: { start: vi.fn(), stop: vi.fn(), subscribe: vi.fn() }, runYtDlp: vi.fn(),
      logins: { login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(), cookieHeader: vi.fn() },
      ensureTools: async () => { throw new ToolError('tool-not-executable', 'ffmpeg') } })
    await expect(acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official')).rejects.toMatchObject({ code: 'tool-not-executable' })
    expect((await diagnostics.report()).attempts[0]).toMatchObject({ status: 'failed', events: expect.arrayContaining([
      expect.objectContaining({ stage: 'resolve', code: 'tool-not-executable' }),
    ]) })
    acquisition.dispose()
  })

  it('keeps concurrent failed requests separate and rejects export arguments that could trigger extra work', async () => {
    const h = serviceFixture()
    h.runYtDlp.mockResolvedValue({ is_live: false, formats: [] })
    await Promise.all([
      h.acquisition.resolve('https://youtu.be/abcdefghijk', 'youtube', 'official'),
      h.acquisition.resolve('https://youtu.be/klmnopqrstu', 'youtube', 'commentary'),
    ])
    expect((await h.diagnostics.report()).attempts.map(attempt => ({ id: attempt.id, role: attempt.role })))
      .toEqual([{ id: 1, role: 'official' }, { id: 2, role: 'commentary' }])
    expect(await h.service.invoke('getAcquisitionDiagnostics', { input: secret })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(h.runYtDlp).toHaveBeenCalledTimes(2)
    h.service.dispose(); h.acquisition.dispose()
  })
})
