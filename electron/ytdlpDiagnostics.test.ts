import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YtDlpRunner, type YtDlpDiagnostic } from './ytdlp'
import { locateTool, locateYouTubePotProvider } from './toolLocator'
import { prepareScriptOnlyPotPlugin } from './potPlugin'
import fixture from '../server/platforms/fixtures/youtube-adaptive-live.json'

vi.mock('./toolLocator', async actual => ({ ...await actual<object>(), locateTool: vi.fn(), locateYouTubePotProvider: vi.fn() }))
vi.mock('./potPlugin', () => ({ prepareScriptOnlyPotPlugin: vi.fn() }))
const cleanup = vi.fn(async () => {})
const runners: YtDlpRunner[] = []
beforeEach(() => {
  vi.mocked(locateTool).mockReset().mockResolvedValue('/private/yt-dlp.exe')
  vi.mocked(locateYouTubePotProvider).mockReset().mockResolvedValue(undefined)
  vi.mocked(prepareScriptOnlyPotPlugin).mockReset().mockResolvedValue({ pluginDir: '/private/script-only', dispose: cleanup })
  cleanup.mockClear()
})
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())); vi.useRealTimers() })

const url = 'https://www.youtube.com/watch?v=abcdefghijk'
const direct = { route: async () => ({ kind: 'direct' as const }) }
const hlsOnly = { ...fixture, formats: fixture.formats.filter(format => format.protocol === 'm3u8_native') }
const videoOnly = { ...fixture, formats: fixture.formats.filter(format => format.protocol === 'https' && format.vcodec !== 'none') }
function output(info: Record<string, unknown>) {
  const { formats = [], ...metadata } = info
  return Buffer.from(JSON.stringify({ metadata, formats }))
}
function harness(diagnostic?: (event: YtDlpDiagnostic) => void, overrides: Partial<ConstructorParameters<typeof YtDlpRunner>[0]> = {}) {
  const launches: { args: string[]; child: ChildProcess }[] = []
  const launch = vi.fn((_file: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }) as unknown as ChildProcess
    launches.push({ args, child }); return child
  }) as unknown as typeof spawn
  const runner = new YtDlpRunner({ electronPath: '/private/electron.exe', networkRuntimePath: '/private/network-runtime.cjs', diagnostic,
    cookies: { withTemporaryCookies: async (_platform, callback) => callback('/private/youtube-cookie-copy.txt') },
    spawn: launch, killTree: async child => { child.emit('close', 1) }, ...overrides })
  runners.push(runner)
  const finish = (index: number, metadata: Record<string, unknown>, stderr = '', code = 0) => {
    const child = launches[index]!.child
    if (stderr) child.stderr!.emit('data', Buffer.from(stderr))
    child.stdout!.emit('data', output(metadata)); child.emit('close', code)
  }
  return { runner, launches, finish, launch }
}

describe('ordinary yt-dlp diagnostics', () => {
  it('keeps concurrent resolve callbacks separate and includes all stages in the shared observer', async () => {
    const shared: YtDlpDiagnostic[] = [], first: YtDlpDiagnostic[] = [], second: YtDlpDiagnostic[] = []
    const h = harness(event => shared.push(event))
    const a = h.runner.resolve(url, true, direct, event => first.push(event))
    const b = h.runner.resolve('https://www.youtube.com/watch?v=klmnopqrstu', true, direct, event => second.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    h.finish(1, { ...hlsOnly, id: 'klmnopqrstu' }); await b
    h.finish(0, hlsOnly); await a
    expect(first.every(event => event.extractionId === 1)).toBe(true)
    expect(second.every(event => event.extractionId === 2)).toBe(true)
    expect(shared.filter(event => event.extractionId === 1)).toEqual(first)
    expect(shared.filter(event => event.extractionId === 2)).toEqual(second)
    expect(first).toContainEqual(expect.objectContaining({ stage: 'hls', status: 'started', client: 'default' }))
    expect(first).toContainEqual(expect.objectContaining({ stage: 'hls', status: 'resolved', client: 'default' }))
    expect(JSON.stringify(shared)).not.toMatch(/abcdefghijk|klmnopqrstu|private|https:\/\/|cookie-copy/)
  })

  it('isolates throwing and mutating observers from extraction and from the per-call snapshot', async () => {
    const perCall: YtDlpDiagnostic[] = []
    const h = harness(event => {
      event.extractionId = -100
      if (event.formats) event.formats.total = -100
      throw new Error('PRIVATE observer error')
    })
    const pending = h.runner.resolve(url, true, direct, event => perCall.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.finish(0, hlsOnly)
    expect(await pending).toEqual(hlsOnly)
    expect(perCall.every(event => event.extractionId === 1)).toBe(true)
    expect(perCall.find(event => event.formats)?.formats?.total).toBe(hlsOnly.formats.length)
  })

  it('reduces malicious formats, stderr and proxy URLs to safe counters and whitelisted values', async () => {
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, { route: async () => ({ kind: 'http', proxyUrl: 'http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1:3128' }) }, event => events.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.finish(0, { ...fixture, Cookie: 'PRIVATE_COOKIE', title: 'PRIVATE_TITLE', formats: [...fixture.formats, null,
      { protocol: 'PRIVATE_PROTOCOL', vcodec: 'PRIVATE_VIDEO_CODEC', acodec: 'PRIVATE_AUDIO_CODEC', url: 'https://PRIVATE_URL/?pot=PRIVATE_TOKEN', http_headers: { Authorization: 'PRIVATE_HEADER' } },
    ] }, 'bgutil PO token unavailable: C:/PRIVATE_DIRECTORY Cookie=PRIVATE_STDERR https://PRIVATE_HOST/?token=PRIVATE_TOKEN')
    await pending
    const completed = events.find(event => event.stage === 'hls' && event.status === 'resolved')!
    expect(completed).toMatchObject({ warnings: ['token-provider'], providerOutcome: 'warning',
      formats: { total: 10, protocols: { hls: 2, https: 6, dash: 0, other: 2 }, videoCodecs: { h264: 2, vp9: 3, av1: 1, none: 2, other: 2 },
        audioCodecs: { aac: 4, opus: 0, none: 4, other: 2 }, muxedHls: 2, adaptivePairs: 3 } })
    expect(events).toContainEqual(expect.objectContaining({ stage: 'route', route: 'http' }))
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|Cookie|Authorization|http_headers|url|127\.0\.0\.1|C:\//)
  })

  it.each([0, 1])('never marks malformed metadata resolved after native exit=%s', async code => {
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    const failure = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.launches[0]!.child.stdout!.emit('data', Buffer.from('{"metadata":{"Cookie":"PRIVATE"},"formats":"PRIVATE"}'))
    h.launches[0]!.child.emit('close', code)
    await failure
    expect(events.filter(event => event.stage === 'hls' && event.status === 'resolved')).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls', status: 'failed', code: code === 0 ? 'invalid-metadata' : 'extractor-failed' }))
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|Cookie/)
  })

  it('records a missing tool before any native process starts', async () => {
    vi.mocked(locateTool).mockRejectedValue(Object.assign(new Error('C:/PRIVATE executable path'), { code: 'tool-missing' }))
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    await expect(h.runner.resolve(url, true, direct, event => events.push(event))).rejects.toThrow()
    expect(h.launches).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ stage: 'resolve', status: 'failed', code: 'tool-missing' })
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it('records proxy selection failure without saving the route or exception text', async () => {
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    await expect(h.runner.resolve(url, true, { route: async () => { throw Object.assign(new Error('http://PRIVATE:SECRET@localhost'), { code: 'ECONNREFUSED' }) } }, event => events.push(event))).rejects.toThrow()
    expect(h.launches).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ stage: 'route', status: 'failed', route: 'unknown', code: 'proxy-unreachable' }))
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|localhost/)
  })

  it.each(['invalid-runtime', 'synchronous-spawn', 'native-spawn'])('classifies a launch failure without raw details: %s', async mode => {
    const events: YtDlpDiagnostic[] = []
    const h = harness(undefined, mode === 'invalid-runtime' ? { networkRuntimePath: 'relative-private-path' }
      : mode === 'synchronous-spawn' ? { spawn: (() => { throw new Error('PRIVATE spawn') }) as unknown as typeof spawn } : {})
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    const failure = expect(pending).rejects.toThrow()
    if (mode === 'native-spawn') {
      await vi.waitFor(() => expect(h.launches).toHaveLength(1))
      h.launches[0]!.child.emit('error', new Error('PRIVATE native error'))
      h.launches[0]!.child.emit('close', 1)
    }
    await failure
    expect(events.filter(event => event.stage === 'hls' && event.status === 'failed')).toEqual([
      expect.objectContaining({ code: mode === 'invalid-runtime' ? 'runtime-unavailable' : 'spawn-failed' }),
    ])
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|private-path/)
  })

  it('keeps cancellation distinct from a native failure', async () => {
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    const failure = expect(pending).rejects.toThrow('取消')
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    await h.runner.dispose(); await failure
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls', status: 'cancelled', stopped: true, stopReason: 'cancelled', code: 'cancelled' }))
  })

  it('caps and deduplicates returned height lists even for arbitrary metadata', async () => {
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.finish(0, { ...hlsOnly, formats: [...hlsOnly.formats, ...Array.from({ length: 100 }, (_, index) => ({ height: index + 1 })), { height: 999999 }, { height: -1 }, { height: 1.5 }] })
    await pending
    const values = events.find(event => event.stage === 'hls' && event.status === 'resolved')!.heights!
    expect(values).toHaveLength(16)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every(value => Number.isInteger(value) && value > 0 && value <= 16384)).toBe(true)
  })

  it('distinguishes provider preparation, returned token evidence and extractor warnings', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue({ pluginDir: '/PRIVATE_PLUGIN', serverHome: '/PRIVATE_SERVER' })
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    expect(events).toContainEqual(expect.objectContaining({ stage: 'provider', status: 'prepared', client: 'web', providerOutcome: 'unconfirmed' }))
    expect(events.some(event => event.providerOutcome === 'token-observed')).toBe(false)
    h.finish(0, hlsOnly)
    h.finish(1, { ...fixture, formats: fixture.formats.map(format => format.url.includes('googlevideo.com') ? { ...format, url: format.url + '&pot=PRIVATE_TOKEN' } : format) })
    await pending
    expect(events).toContainEqual(expect.objectContaining({ stage: 'adaptive', client: 'web', status: 'resolved', providerOutcome: 'token-observed' }))
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|pot=|googlevideo/)
  })

  it('reports provider preparation failure while preserving default extraction', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue({ pluginDir: '/PRIVATE_PLUGIN', serverHome: '/PRIVATE_SERVER' })
    vi.mocked(prepareScriptOnlyPotPlugin).mockRejectedValue(new Error('PRIVATE plugin path'))
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.finish(0, hlsOnly); await pending
    expect(events).toContainEqual(expect.objectContaining({ stage: 'provider', client: 'web', status: 'failed', code: 'provider-prepare-failed' }))
    expect(events).toContainEqual(expect.objectContaining({ stage: 'adaptive', client: 'web', status: 'skipped', code: 'provider-prepare-failed' }))
    expect(events.some(event => event.stage === 'adaptive' && event.status === 'started')).toBe(false)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|plugin path/)
  })

  it('records separate outcomes for default, adaptive and the actual Safari fallback', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue({ pluginDir: '/PRIVATE_PLUGIN', serverHome: '/PRIVATE_SERVER' })
    const events: YtDlpDiagnostic[] = []
    const h = harness()
    const pending = h.runner.resolve(url, true, direct, event => events.push(event))
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    h.finish(0, videoOnly); h.finish(1, videoOnly, 'PO token unavailable Cookie=PRIVATE')
    await vi.waitFor(() => expect(h.launches).toHaveLength(3))
    h.finish(2, hlsOnly); await pending
    for (const [stage, client] of [['hls', 'default'], ['adaptive', 'web'], ['hls-fallback', 'web_safari']] as const) {
      expect(events).toContainEqual(expect.objectContaining({ stage, client, status: 'started', extractionId: 1 }))
      expect(events).toContainEqual(expect.objectContaining({ stage, client, status: 'resolved', extractionId: 1 }))
    }
    expect(events).toContainEqual(expect.objectContaining({ stage: 'adaptive', providerOutcome: 'warning' }))
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls-fallback', providerConfigured: true, formats: expect.objectContaining({ muxedHls: 2 }) }))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })
})
