import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YOUTUBE_METADATA_TEMPLATE, YtDlpRunner, type YtDlpDiagnostic } from './ytdlp'
import { locateYouTubePotProvider } from './toolLocator'
import adaptiveFixture from '../server/platforms/fixtures/youtube-adaptive-live.json'
import { prepareScriptOnlyPotPlugin } from './potPlugin'

vi.mock('./toolLocator', async (actual) => ({ ...await actual<object>(), locateTool: vi.fn(async () => '/tools/yt-dlp.exe'), locateYouTubePotProvider: vi.fn(async () => undefined) }))
vi.mock('./potPlugin', () => ({ prepareScriptOnlyPotPlugin: vi.fn() }))
const pluginCleanup = vi.fn(async () => {})
beforeEach(() => {
  vi.mocked(locateYouTubePotProvider).mockReset().mockResolvedValue(undefined)
  vi.mocked(prepareScriptOnlyPotPlugin).mockReset().mockResolvedValue({ pluginDir: '/private/script-only', dispose: pluginCleanup })
  pluginCleanup.mockClear()
})
afterEach(() => vi.useRealTimers())

function harness(diagnostic?: (event: YtDlpDiagnostic) => void) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }) as unknown as ChildProcess
  const launch = vi.fn(() => child) as unknown as typeof spawn
  const cleanup = vi.fn()
  const cookies = { withTemporaryCookies: vi.fn(async (_platform, callback) => {
    try { return await callback('/private/copy.txt') } finally { cleanup() }
  }) }
  const killTree = vi.fn(async () => { child.emit('close', 1) })
  const runner = new YtDlpRunner({ electronPath: '/electron.exe', networkRuntimePath: '/application/runtime/network-runtime.cjs', cookies, spawn: launch,
    toolContext: { providerCacheHome: '/private/provider-cache' },
    env: { PATH: 'kept', EXAMPLE: 'unchanged' }, timeoutMs: 100, killTree, diagnostic })
  return { child, launch, cleanup, cookies, runner, killTree }
}

function metadataOutput(info: Record<string, unknown>): Buffer {
  const { formats = [], ...metadata } = info
  return Buffer.from(JSON.stringify({ metadata, formats }))
}

describe('isolated yt-dlp execution', () => {
  it('emits only fixed classifications and numeric format data to optional diagnostics', async () => {
    const events: YtDlpDiagnostic[] = []
    const h = harness(event => events.push(event))
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    h.child.stderr!.emit('data', Buffer.from('bgutil PO token unavailable: https://signed.invalid/?token=PRIVATE Cookie=SECRET C:/private/location'))
    h.child.stdout!.emit('data', metadataOutput(adaptiveFixture))
    h.child.emit('close', 0)
    await pending
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls', warnings: ['token-provider'] }))
    expect(events).toContainEqual(expect.objectContaining({ heights: expect.arrayContaining([1440]), adaptiveHeights: expect.arrayContaining([1440]) }))
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|https|googlevideo|Cookie|location/)
  })
  it('uses argument arrays, a temporary cookie path and child-only Electron Node mode', async () => {
    const h = harness()
    const inherited = process.env.ELECTRON_RUN_AS_NODE
    const inheritedCache = process.env.XDG_CACHE_HOME
    const inheritedNodeOptions = process.env.NODE_OPTIONS
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    const [executable, args, options] = vi.mocked(h.launch).mock.calls[0]!
    expect(executable).toBe('/tools/yt-dlp.exe')
    expect(args).toEqual(expect.arrayContaining(['--print', YOUTUBE_METADATA_TEMPLATE, '--cookies', '/private/copy.txt', '--js-runtimes', 'node:/electron.exe', '--ignore-config', '--no-remote-components']))
    expect(options).toMatchObject({ shell: false, env: { ELECTRON_RUN_AS_NODE: '1', XDG_CACHE_HOME: '/private/provider-cache', PATH: 'kept', NODE_OPTIONS: '--require="/application/runtime/network-runtime.cjs"' } })
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(inherited)
    expect(process.env.XDG_CACHE_HOME).toBe(inheritedCache)
    expect(process.env.NODE_OPTIONS).toBe(inheritedNodeOptions)
    h.child.stdout!.emit('data', metadataOutput({ is_live: true }))
    h.child.emit('close', 0)
    expect(await pending).toEqual({ is_live: true, formats: [] })
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it('classifies authentication without exposing stderr or cookie values', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow(/^YouTube sign in required$/)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    h.child.stderr!.emit('data', Buffer.from('sign in required Cookie=PRIVATE https://secret.invalid/?token=PRIVATE'))
    h.child.emit('close', 1)
    await rejected
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it('kills the whole runtime tree and finishes cookie cleanup during disposal', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow('取消')
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    await h.runner.dispose()
    await rejected
    expect(h.killTree).toHaveBeenCalledWith(h.child)
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it('caps UTF-8 bytes and terminates once when overflow, timeout and disposal overlap', async () => {
    vi.useFakeTimers()
    const events: YtDlpDiagnostic[] = []
    const h = harness(event => events.push(event))
    let completeKill!: () => void
    h.killTree.mockImplementation(() => new Promise<void>(resolve => {
      completeKill = () => { h.child.emit('close', 1); resolve() }
    }))
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow(/^yt-dlp 媒体信息超过大小限制$/)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    // This is 17 MiB of UTF-8 data but only 11 MiB of JavaScript characters.
    h.child.stdout!.emit('data', Buffer.from('汉'.repeat(3 * 1_048_576)))
    h.child.stdout!.emit('data', Buffer.alloc(8 * 1_048_576, 'a'))
    for (let i = 0; i < 20; i++) h.child.stdout!.emit('data', Buffer.from('PRIVATE'))
    await vi.advanceTimersByTimeAsync(200)
    const disposal = h.runner.dispose()
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child)
    completeKill()
    await disposal
    await rejected
    expect(h.cleanup).toHaveBeenCalledOnce()
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls', stopped: true, stopReason: 'output-limit' }))
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
  })

  it('keeps a timeout distinct from oversized metadata', async () => {
    vi.useFakeTimers()
    const events: YtDlpDiagnostic[] = []
    const h = harness(event => events.push(event))
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
    const rejected = expect(pending).rejects.toThrow(/^yt-dlp 超时或已取消$/)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(200)
    await rejected
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child)
    expect(events).toContainEqual(expect.objectContaining({ stage: 'hls', stopReason: 'timeout' }))
    expect(h.cleanup).toHaveBeenCalledOnce()
  })

  it.each([{ formats: [] }, { metadata: [], formats: [] }, { metadata: { is_live: true }, formats: 'PRIVATE' }])(
    'rejects malformed projected metadata without echoing it', async output => {
      const h = harness()
      const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk')
      const rejected = expect(pending).rejects.toThrow(/^yt-dlp 返回无效的媒体信息$/)
      await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
      h.child.stdout!.emit('data', Buffer.from(JSON.stringify(output)))
      h.child.emit('close', 0)
      await rejected
      expect(h.cleanup).toHaveBeenCalledOnce()
    },
  )
})

describe('optional yt-dlp PO token script integration', () => {
  const url = 'https://www.youtube.com/watch?v=abcdefghijk'
  const provider = { pluginDir: '/private/plugins', serverHome: '/private/provider home' }

  it('keeps HLS extraction options and requests projected metadata when the provider is absent', async () => {
    const h = harness()
    const pending = h.runner.resolve(url)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    expect(vi.mocked(h.launch).mock.calls[0]![1]).toEqual([
      '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
      '--socket-timeout', '20', '--retries', '1', '--extractor-retries', '1',
      '--no-js-runtimes', '--js-runtimes', 'node:/electron.exe',
      '--no-remote-components', '--skip-download', '--print', YOUTUBE_METADATA_TEMPLATE, '--cookies', '/private/copy.txt', '--', url,
    ])
    h.child.stdout!.emit('data', metadataOutput({ is_live: true }))
    h.child.emit('close', 0)
    await pending
  })

  /** One fake child per launch; the adaptive run is the one carrying --plugin-dirs. */
  function forked() {
    const children: { child: ChildProcess; args: string[] }[] = []
    const launch = vi.fn((_file: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }) as unknown as ChildProcess
      children.push({ child, args })
      return child
    }) as unknown as typeof spawn
    const cleanup = vi.fn()
    const cookies = { withTemporaryCookies: vi.fn(async (_platform, callback) => {
      try { return await callback('/private/copy.txt') } finally { cleanup() }
    }) }
    const killTree = vi.fn(async (child: ChildProcess) => { child.emit('close', 1) })
    const runner = new YtDlpRunner({ electronPath: '/electron.exe', networkRuntimePath: '/application/runtime/network-runtime.cjs', cookies, spawn: launch,
      env: { PATH: 'kept' }, timeoutMs: 1000, killTree })
    const run = (kind: 'hls' | 'adaptive') => children.find(({ args }) => args.includes('--plugin-dirs') === (kind === 'adaptive'))!
    const finish = (kind: 'hls' | 'adaptive', code: number, body?: unknown) => {
      const { child } = run(kind)
      if (body !== undefined) child.stdout!.emit('data', metadataOutput(body as Record<string, unknown>))
      child.emit('close', code)
    }
    return { launch, cleanup, cookies, runner, run, finish, children }
  }
  const hlsOnly = { ...adaptiveFixture, formats: adaptiveFixture.formats.filter((f) => f.protocol === 'm3u8_native') }
  const webOnly = { ...adaptiveFixture, formats: adaptiveFixture.formats.filter((f) => f.protocol === 'https') }

  it('runs the unchanged HLS extraction and a script-only adaptive one, and merges them', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = forked()
    const inherited = process.env.ELECTRON_RUN_AS_NODE
    const pending = h.runner.resolve(url)
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    const adaptiveArgs = h.run('adaptive').args
    expect(adaptiveArgs).toEqual(expect.arrayContaining(['--no-plugin-dirs', '--plugin-dirs', '/private/script-only',
      '--extractor-args', `youtubepot-bgutilscript:server_home=${provider.serverHome}`,
      '--extractor-args', 'youtube:player_client=web;formats=incomplete']))
    expect(JSON.stringify(adaptiveArgs)).not.toMatch(/4416|http.js|server.js|listen|base_url/)
    expect(h.run('hls').args).not.toContain('--extractor-args')
    expect(vi.mocked(h.launch).mock.calls.every(([, , options]) => (options as { shell: boolean; env: NodeJS.ProcessEnv }).shell === false
      && (options as { env: NodeJS.ProcessEnv }).env.ELECTRON_RUN_AS_NODE === '1')).toBe(true)
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(inherited)
    // Simulate clients exposing disjoint HLS and adaptive format sets.
    h.finish('adaptive', 0, webOnly)
    h.finish('hls', 0, hlsOnly)
    const merged = await pending as typeof adaptiveFixture
    const ids = merged.formats.map((f) => f.format_id)
    expect(ids).toEqual(expect.arrayContaining(['300', '301', '308', '140']))
    // Only what the adaptive selector accepts is carried over: one codec per height (VP9 over
    // AV1), nothing at or below the best HLS height, no spare audio.
    expect(ids).not.toContain('400')
    expect(ids).not.toContain('248')
    expect(ids).not.toContain('139')
    expect(h.cleanup).toHaveBeenCalledOnce()
    expect(pluginCleanup).toHaveBeenCalledOnce()
  })

  it.each(['provider-error', 'no-adaptive'])('returns the plain HLS extraction after %s', async (failure) => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = forked()
    const pending = h.runner.resolve(url)
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.run('adaptive').child.stderr!.emit('data', Buffer.from('provider failure token=PRIVATE Cookie=PRIVATE'))
    if (failure === 'no-adaptive') h.finish('adaptive', 0, { is_live: true, formats: [] })
    else h.finish('adaptive', 1)
    h.finish('hls', 0, hlsOnly)
    expect(await pending).toEqual(hlsOnly)
    expect(h.cookies.withTemporaryCookies).toHaveBeenCalledOnce()
    expect(pluginCleanup).toHaveBeenCalledOnce()
  })

  it.each([
    { id: 'differentId' },
    { is_live: false },
    { live_status: 'post_live' },
  ])('keeps HLS when the web extraction is a different or non-live broadcast: %j', async metadata => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = forked()
    const pending = h.runner.resolve(url)
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.finish('adaptive', 0, { ...webOnly, ...metadata })
    h.finish('hls', 0, hlsOnly)
    expect(await pending).toEqual(hlsOnly)
    expect(pluginCleanup).toHaveBeenCalledOnce()
  })

  it('fails as before when the HLS extraction fails, whatever the provider returned', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = forked()
    const pending = h.runner.resolve(url)
    const rejected = expect(pending).rejects.toThrow('YouTube sign in required')
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.finish('adaptive', 0, webOnly)
    h.run('hls').child.stderr!.emit('data', Buffer.from('Sign in to confirm you are not a bot'))
    h.finish('hls', 1)
    await rejected
  })

  it('cancels both extractions on disposal', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = forked()
    const pending = h.runner.resolve(url)
    const rejected = expect(pending).rejects.toThrow('取消')
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    await h.runner.dispose()
    await rejected
    expect(h.children).toHaveLength(2)
    expect(pluginCleanup).toHaveBeenCalledOnce()
  })

  it('uses the original HLS result after private plugin preparation fails', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    vi.mocked(prepareScriptOnlyPotPlugin).mockRejectedValue(new Error('private installation path'))
    const h = forked()
    const pending = h.runner.resolve(url)
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    expect(h.children[0]!.args).not.toContain('--plugin-dirs')
    h.finish('hls', 0, { is_live: true })
    expect(await pending).toEqual({ is_live: true, formats: [] })
    expect(pluginCleanup).not.toHaveBeenCalled()
  })

  it('skips provider discovery and preparation for an explicit HLS-only retry', async () => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(provider)
    const h = harness()
    const pending = h.runner.resolve(url, false)
    await vi.waitFor(() => expect(h.launch).toHaveBeenCalledOnce())
    expect(locateYouTubePotProvider).not.toHaveBeenCalled()
    expect(prepareScriptOnlyPotPlugin).not.toHaveBeenCalled()
    const args = vi.mocked(h.launch).mock.calls[0]![1]!
    expect(args).not.toContain('--plugin-dirs')
    expect(args).not.toContain('--extractor-args')
    h.child.stdout!.emit('data', metadataOutput({ is_live: true }))
    h.child.emit('close', 0)
    await pending
  })
})
