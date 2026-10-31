import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { YouTubeImportJobManager, classifyYtImportError, normalizeYtImportUrl, type YtImportJob, type YtImportOptions, type YtImportRequest } from './ytImport'
import { locateYouTubePotProvider } from './toolLocator'
import { prepareScriptOnlyPotPlugin } from './potPlugin'
import { YtDlpRunner } from './ytdlp'

vi.mock('./toolLocator', async actual => ({ ...await actual<object>(),
  locateTool: vi.fn(async (tool: string) => path.resolve(`.runtime-cache/mock-tools/${tool}.exe`)),
  locateYouTubePotProvider: vi.fn(async () => ({ pluginDir: '/provider', serverHome: '/server' })),
}))
vi.mock('./potPlugin', () => ({ prepareScriptOnlyPotPlugin: vi.fn(async () => ({ pluginDir: '/private/plugin', dispose: vi.fn(async () => {}) })) }))
const videoId = 'a1b2c3d4e5F'
const request: YtImportRequest = { url: `https://www.youtube.com/watch?v=${videoId}`, startSeconds: 40, endSeconds: 55, targetHeight: 2160 }
const runtimePath = path.resolve('.runtime-cache/mock-tools/network-runtime.cjs')
const roots: string[] = []
beforeEach(() => {
  vi.mocked(locateYouTubePotProvider).mockReset().mockResolvedValue({ pluginDir: '/provider', serverHome: '/server' })
  vi.mocked(prepareScriptOnlyPotPlugin).mockClear()
})
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true })
})
const probeInfo = () => ({ metadata: { id: videoId, title: '本地 mock 录像', duration: 1000, is_live: false, live_status: 'was_live' }, formats: [
  { format_id: '399', url: 'https://media.googlevideo.com/signed?token=PRIVATE_URL', protocol: 'https', width: 3840, height: 2160, fps: 60, tbr: 18000, vcodec: 'av01.0.13M.08', acodec: 'none', ext: 'mp4' },
  { format_id: '137', url: 'https://media.googlevideo.com/low', protocol: 'https', width: 1920, height: 1080, fps: 60, tbr: 4000, vcodec: 'avc1', acodec: 'none', ext: 'mp4' },
  { format_id: '251', url: 'https://media.googlevideo.com/audio', protocol: 'https', tbr: 150, abr: 150, vcodec: 'none', acodec: 'opus', ext: 'webm' },
  { format_id: '400', url: 'https://media.googlevideo.com/1440', protocol: 'https', width: 2560, height: 1440, fps: 60, tbr: 9000, vcodec: 'av01.0.12M.08', acodec: 'none', ext: 'mp4' },
] })

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(), pid: 9000 }) as unknown as ChildProcess
}
function harness(options: { info?: ReturnType<typeof probeInfo>; hold?: 'probe' | 'download'; failure?: string; freeBytes?: number; cookieFile?: string | null; verifyWidth?: number; verifyHeight?: number; publishFailure?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ytimport-test-'))
  roots.push(root)
  const launches: Array<{ child: ChildProcess; args: string[]; options: Record<string, unknown> }> = []
  const events: YtImportJob[] = []
  const cookieCleaned = vi.fn()
  const publish = vi.fn((assetId: string, file: string) => {
    expect(cookieCleaned).toHaveBeenCalled()
    expect(file).toBe(path.join(root, 'admin-media', assetId, 'media.mp4'))
    if (options.publishFailure) throw new Error('private local path')
    return `app://app/admin-media/${assetId}`
  })
  const cookies = { withTemporaryCookies: vi.fn(async (_platform, callback) => {
    try { return await callback(options.cookieFile === null ? undefined : options.cookieFile ?? '/private/COOKIE_SECRET.txt') } finally { cookieCleaned() }
  }) } as YtImportOptions['cookies']
  const launch = vi.fn((_executable, args: string[], spawnOptions) => {
    const process = child()
    launches.push({ child: process, args, options: spawnOptions })
    const stage = args.includes('--skip-download') ? 'probe' : args.includes('--download-sections') ? 'download' : 'verify'
    if (stage === options.hold) return process
    setImmediate(() => {
      if (stage === 'probe') process.stdout!.emit('data', Buffer.from(JSON.stringify(options.info ?? probeInfo())))
      else if (stage === 'download') {
        if (options.failure) { process.stderr!.emit('data', Buffer.from(options.failure)); process.emit('close', 1); return }
        const template = args[args.indexOf('--output') + 1]!
        fs.writeFileSync(template.replace('%(ext)s', 'mp4'), 'local synthetic media bytes')
        process.stdout!.emit('data', Buffer.from('FY1_PROGRESS:[1024,2048,100,10]\n'))
      } else {
        const download = launches.find(launch => launch.args.includes('--download-sections'))!.args
        const id = download[download.indexOf('--format') + 1]!.split('+')[0]
        const format = (options.info ?? probeInfo()).formats.find(format => format.format_id === id)!
        process.stdout!.emit('data', Buffer.from(JSON.stringify({ streams: [
          { codec_type: 'video', codec_name: format.vcodec.startsWith('avc1') ? 'h264' : 'av1',
            width: options.verifyWidth ?? format.width, height: options.verifyHeight ?? format.height, avg_frame_rate: '60/1' },
          { codec_type: 'audio', codec_name: 'opus' },
        ] })))
      }
      process.emit('close', 0)
    })
    return process
  }) as unknown as typeof spawn
  const killTree = vi.fn(async (process: ChildProcess) => { process.emit('close', 1) })
  const manager = new YouTubeImportJobManager({ userDataDirectory: root, electronPath: '/electron.exe', networkRuntimePath: runtimePath,
    cookies, spawn: launch, killTree, event: job => events.push(job), publish, freeBytes: async () => options.freeBytes ?? 100 * 1024 ** 3,
    network: () => ({ route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }) }),
    env: options.env ?? { HTTP_PROXY: 'http://inherited.invalid', no_proxy: '*', PATH: 'safe' } })
  return { manager, launches, launch, killTree, cookies, events, publish, cookieCleaned, root }
}
async function settled(manager: YouTubeImportJobManager): Promise<YtImportJob> {
  await vi.waitFor(() => expect(['ready', 'failed', 'cancelled']).toContain(manager.list()[0]?.state))
  return manager.list()[0]!
}

describe('YouTube section imports', () => {
  it('pins selected video/audio IDs, private cookies, section, copy codecs, runtime, plugin and selected proxy', async () => {
    const h = harness()
    const initial = h.manager.start(request)
    expect(initial.state).toBe('probing')
    const job = await settled(h.manager)
    expect(job.state).toBe('ready')
    expect(h.launches).toHaveLength(3)
    const args = h.launches[1]!.args
    expect(args.slice(0, 2)).toEqual(['--proxy', 'http://127.0.0.1:3128'])
    for (const [flag, value] of [['--format', '399+251'], ['--download-sections', '*40-55'], ['--cookies', '/private/COOKIE_SECRET.txt'],
      ['--js-runtimes', 'node:/electron.exe'], ['--plugin-dirs', '/private/plugin'], ['--downloader-args', 'ffmpeg_o:-c:v copy -c:a copy'],
      ['--merge-output-format', 'mp4'], ['--remux-video', 'mp4']]) expect(args[args.indexOf(flag!) + 1]).toBe(value)
    expect(args).toContain('--no-force-keyframes-at-cuts')
    expect(args.join(' ')).not.toContain('formats=incomplete')
    const spawnOptions = h.launches[1]!.options
    expect(spawnOptions).toMatchObject({ shell: false, windowsHide: true })
    const env = spawnOptions.env as NodeJS.ProcessEnv
    expect(env.no_proxy).toBeUndefined()
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:3128')
    expect(env.NODE_OPTIONS).toContain('--require=')
    expect(job).toMatchObject({ format: { width: 3840, height: 2160, container: 'mp4' }, assetId: job.jobId, progress: { percent: 100 } })
    expect(job.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(h.publish).toHaveBeenCalledOnce()
    const metadata = JSON.parse(fs.readFileSync(path.join(h.root, 'admin-media', job.jobId, 'metadata.json'), 'utf8'))
    expect(Object.keys(metadata).sort()).toEqual(['downloadedAt', 'endSeconds', 'format', 'sha256', 'size', 'startSeconds', 'title', 'videoId'])
    expect(JSON.stringify([job, h.events, metadata])).not.toMatch(/PRIVATE_URL|COOKIE_SECRET|googlevideo|cookieFile|pluginDir/)
    await h.manager.dispose()
  })

  it.each([[2160, 3840, '399'], [1440, 2560, '400'], [1080, 1920, '137']] as const)('downloads the requested %sp track without choosing another height', async (targetHeight, width, videoFormatId) => {
    const h = harness()
    expect(h.manager.start({ ...request, targetHeight })).toMatchObject({ state: 'probing', targetHeight })
    const job = await settled(h.manager)
    expect(job).toMatchObject({ state: 'ready', targetHeight, format: { videoFormatId, audioFormatId: '251', width, height: targetHeight } })
    const args = h.launches[1]!.args
    expect(args[args.indexOf('--format') + 1]).toBe(`${videoFormatId}+251`)
    expect(job.sha256).toMatch(/^[0-9a-f]{64}$/)
    await h.manager.dispose()
  })

  it.each([
    ['width', { width: 4096, fps: 24, quality: 0, tbr: 1000 }],
    ['fps', { fps: 120, quality: 0, tbr: 1000 }],
    ['quality', { quality: 11, tbr: 1000 }],
    ['tbr', { tbr: 21000 }],
  ] as const)('preserves %s priority among formats at the requested height', async (_field, better) => {
    const info = probeInfo()
    const lower = { ...info.formats[0]!, format_id: 'lower', width: 3840, height: 2160, fps: 60, quality: 10, tbr: 20000, abr: undefined }
    const selected = { ...lower, format_id: 'selected', ...better }
    info.formats = [lower, selected, info.formats[2]!, { ...lower, format_id: '8k', width: 7680, height: 4320 }]
    const h = harness({ info })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready', format: { videoFormatId: 'selected', width: selected.width, height: 2160 } })
    const args = h.launches[1]!.args
    expect(args[args.indexOf('--format') + 1]).toBe('selected+251')
    await h.manager.dispose()
  })

  it.each([2160, 1440, 1080] as const)('fails with the requested %sp in the message when that height is absent', async targetHeight => {
    const info = probeInfo()
    info.formats = info.formats.filter(format => format.height !== targetHeight)
    const h = harness({ info })
    h.manager.start({ ...request, targetHeight })
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', targetHeight,
      error: { code: 'format-unavailable', message: `${targetHeight}p 画质不可用或无法无损封装, 未改用其他画质.` } })
    expect(h.launches).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it('rejects unsupported or missing heights without spawning', async () => {
    const h = harness()
    for (const targetHeight of [undefined, null, '2160', 0, 720, 1440.5, 4320, NaN, Infinity, [2160]]) {
      expect(() => h.manager.start({ ...request, targetHeight } as unknown as YtImportRequest)).toThrow('选段参数无效')
    }
    expect(() => h.manager.start({ url: request.url, startSeconds: 40, endSeconds: 55 } as YtImportRequest)).toThrow('选段参数无效')
    expect(h.launches).toEqual([])
    await h.manager.dispose()
  })

  it('restores only complete, hashed registered assets and ignores extra sidecar fields', async () => {
    const h = harness()
    h.manager.start(request)
    const job = await settled(h.manager)
    const publish = vi.fn((id: string) => `app://app/admin-media/${id}`)
    const restored = new YouTubeImportJobManager({ userDataDirectory: h.root, electronPath: '', networkRuntimePath: runtimePath, cookies: h.cookies, publish })
    await restored.initialize()
    expect(restored.list()[0]).toMatchObject({ state: 'ready', jobId: job.jobId, format: { width: 3840, height: 2160 }, mediaUrl: `app://app/admin-media/${job.jobId}` })
    expect(restored.list()[0]).not.toHaveProperty('targetHeight')
    const sidecar = path.join(h.root, 'admin-media', job.jobId, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    metadata.cookie = 'SECRET'
    fs.writeFileSync(sidecar, JSON.stringify(metadata))
    const rejected = new YouTubeImportJobManager({ userDataDirectory: h.root, electronPath: '', networkRuntimePath: runtimePath, cookies: h.cookies, publish })
    await rejected.initialize()
    expect(rejected.list()).toEqual([])
    await h.manager.dispose(); await restored.dispose(); await rejected.dispose()
  })

  it.each(['is_live', 'is_upcoming', 'post_live'])('rejects %s before downloading', async status => {
    const info = probeInfo(); info.metadata.live_status = status
    const h = harness({ info })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'live-not-supported' } })
    expect(h.launches).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it('rejects more than five minutes and invalid intervals without spawning', async () => {
    const h = harness()
    expect(() => h.manager.start({ ...request, endSeconds: 341 })).toThrow('5 分钟')
    for (const interval of [[-1, 5], [5, 5], [10, 1], [0, Infinity], [0, NaN]]) {
      expect(() => h.manager.start({ ...request, startSeconds: interval[0]!, endSeconds: interval[1]! })).toThrow('选段参数无效')
    }
    expect(h.launches).toEqual([])
    await h.manager.dispose()
  })

  it.each([0, 30 * 1024 ** 2])('refuses insufficient free disk space: %s', async freeBytes => {
    const h = harness({ freeBytes })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'disk-full' } })
    expect(h.launches).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it('refuses estimated clips exceeding 2GiB', async () => {
    const info = probeInfo(); info.formats[0]!.tbr = 1_000_000
    const h = harness({ info })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'disk-full' } })
    expect(h.launches).toHaveLength(1)
    await h.manager.dispose()
  })

  it.each(['probe', 'download'] as const)('cancels the entire owned process tree during %s and enforces single concurrency', async hold => {
    const h = harness({ hold })
    const job = h.manager.start(request)
    await vi.waitFor(() => expect(h.launches).toHaveLength(hold === 'probe' ? 1 : 2))
    expect(() => h.manager.start(request)).toThrow('已有下载任务')
    const active = h.launches.at(-1)!.child
    const cancelled = await h.manager.cancel(job.jobId)
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(active)
    expect(cancelled).toMatchObject({ state: 'cancelled', error: { code: 'cancelled' } })
    expect(h.publish).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(h.root, 'admin-media', job.jobId, 'metadata.json'))).toBe(false)
    expect(h.cookieCleaned).toHaveBeenCalledOnce()
    await h.manager.dispose()
  })

  it.each([
    ['Sign in to confirm you are not a bot', 'bot-challenge'], ['Please sign in', 'auth-required'],
    ['HTTP Error 429', 'rate-limited'], ['not available in your country', 'geo-restricted'],
    ['Video unavailable', 'video-unavailable'], ['Requested format is not available', 'format-unavailable'],
    ['PO token generation failed', 'provider-failed'], ['No space left on device', 'disk-full'], ['connection timed out', 'network'],
  ])('classifies %s and never exposes private stderr', async (failure, code) => {
    const h = harness({ failure: `${failure}: https://signed.googlevideo.com/?SECRET Cookie=COOKIE_SECRET` })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code } })
    expect(h.publish).not.toHaveBeenCalled()
    expect(JSON.stringify(h.events)).not.toMatch(/SECRET|signed\.googlevideo/)
    await h.manager.dispose()
  })

  it('requires stored cookies and a usable provider', async () => {
    const h = harness({ cookieFile: null })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ error: { code: 'auth-required' } })
    expect(h.launches).toEqual([])
    await h.manager.dispose()
    vi.mocked(locateYouTubePotProvider).mockResolvedValue(undefined)
    const missing = harness()
    missing.manager.start(request)
    expect(await settled(missing.manager)).toMatchObject({ error: { code: 'provider-failed' } })
    expect(missing.launches).toEqual([])
    await missing.manager.dispose()
  })

  it('rejects a result whose actual dimensions differ from the pinned source', async () => {
    const h = harness({ verifyWidth: 1920 })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'format-unavailable' } })
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it('rejects a result whose actual height differs from the requested 1440p', async () => {
    const h = harness({ verifyHeight: 1080 })
    h.manager.start({ ...request, targetHeight: 1440 })
    expect(await settled(h.manager)).toMatchObject({ state: 'failed',
      error: { code: 'format-unavailable', message: '1440p 画质不可用或无法无损封装, 未改用其他画质.' } })
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it.each(['http_dash_segments', 'sabr'])('rejects highest video using %s instead of downloading lower HTTPS quality', async protocol => {
    const info = probeInfo()
    info.formats[0]!.protocol = protocol
    const h = harness({ info })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'format-unavailable' } })
    expect(h.launches).toHaveLength(1)
    expect(h.launches[0]!.args).toContain('--skip-download')
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it.each(['http_dash_segments', 'sabr'])('rejects highest audio using %s instead of selecting lower HTTPS audio', async protocol => {
    const info = probeInfo()
    info.formats.push({ format_id: '140', url: 'https://media.googlevideo.com/lower-audio', protocol: 'https',
      tbr: 128, abr: 128, vcodec: 'none', acodec: 'mp4a.40.2', ext: 'm4a' })
    info.formats[2]!.protocol = protocol
    const h = harness({ info })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'format-unavailable' } })
    expect(h.launches).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it('cannot cancel a separate live runner', async () => {
    const live = child()
    const liveKill = vi.fn(async () => { live.emit('close', 1) })
    const cookies = { withTemporaryCookies: async (_platform, callback) => callback('/private/COOKIE_SECRET.txt') } as YtImportOptions['cookies']
    const runner = new YtDlpRunner({ electronPath: '/electron.exe', networkRuntimePath: runtimePath, cookies,
      spawn: vi.fn(() => live) as unknown as typeof spawn, killTree: liveKill })
    const livePending = runner.resolve(request.url, false)
    await vi.waitFor(() => expect(live.listenerCount('close')).toBeGreaterThan(0))
    const h = harness({ hold: 'download' })
    const job = h.manager.start(request)
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    await h.manager.cancel(job.jobId)
    expect(liveKill).not.toHaveBeenCalled()
    live.stdout!.emit('data', Buffer.from(JSON.stringify({ metadata: { id: videoId, is_live: true }, formats: [] })))
    live.emit('close', 0)
    await expect(livePending).resolves.toMatchObject({ id: videoId, is_live: true })
    await runner.dispose(); await h.manager.dispose()
  })
})

describe('public request and error boundaries', () => {
  it('accepts only known HTTPS video URL shapes and normalizes away unrelated parameters', () => {
    expect(normalizeYtImportUrl(`https://youtu.be/${videoId}?tracking=anything`)).toEqual({ videoId, url: request.url })
    for (const value of ['http://www.youtube.com/watch?v=' + videoId, 'https://youtube.com.evil/watch?v=' + videoId,
      'https://user:pass@www.youtube.com/watch?v=' + videoId, 'https://www.youtube.com:8443/watch?v=' + videoId,
      'file:///secret', 'https://www.youtube.com/channel/' + videoId]) expect(() => normalizeYtImportUrl(value)).toThrow()
    expect(classifyYtImportError('opaque secret')).toBe('network')
  })
})
