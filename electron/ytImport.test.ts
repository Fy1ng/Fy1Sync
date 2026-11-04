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
import type { NetworkRoute } from '../server/networkPolicy'
import { StreamFailureError } from '../server/networkFailure'

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
function harness(options: { info?: ReturnType<typeof probeInfo>; hold?: 'probe' | 'download'; failure?: string; probeFailures?: string[]; freeBytes?: number; cookieFile?: string | null; verifyWidth?: number; verifyHeight?: number; publishFailure?: boolean; env?: NodeJS.ProcessEnv; downloadTimeoutMs?: number; network?: YtImportOptions['network']; mediaInput?: YtImportOptions['mediaInput'] } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ytimport-test-'))
  roots.push(root)
  const launches: Array<{ child: ChildProcess; args: string[]; options: Record<string, unknown> }> = []
  let probeCount = 0
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
    const stage = args.includes('--skip-download') ? 'probe' : args.includes('--download-sections') || args.includes('-progress') ? 'download' : 'verify'
    if (stage === options.hold) return process
    setImmediate(() => {
      if (stage === 'probe') {
        const failure = options.probeFailures?.[probeCount++]
        if (failure) { process.stderr!.emit('data', Buffer.from(failure)); process.emit('close', 1); return }
        process.stdout!.emit('data', Buffer.from(JSON.stringify(options.info ?? probeInfo())))
      }
      else if (stage === 'download') {
        if (options.failure) { process.stderr!.emit('data', Buffer.from(options.failure)); process.emit('close', 1); return }
        const template = args.includes('--output') ? args[args.indexOf('--output') + 1]! : args.at(-1)!
        fs.writeFileSync(template.replace('%(ext)s', 'mp4'), 'local synthetic media bytes')
        process.stdout!.emit('data', Buffer.from('FY1_PROGRESS:[1024,2048,100,10]\n'))
      } else {
        const download = launches.find(launch => launch.args.includes('--download-sections') || launch.args.includes('-progress'))!.args
        const id = download.includes('--format') ? download[download.indexOf('--format') + 1]!.split('+')[0]
          : (options.info ?? probeInfo()).formats.find(format => format.height === manager.list()[0]?.targetHeight)!.format_id
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
    cookies, spawn: launch, killTree, downloadTimeoutMs: options.downloadTimeoutMs, event: job => events.push(job), publish, freeBytes: async () => options.freeBytes ?? 100 * 1024 ** 3,
    network: options.network ?? (() => ({ route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }) })), mediaInput: options.mediaInput,
    env: options.env ?? { HTTP_PROXY: 'http://inherited.invalid', no_proxy: '*', PATH: 'safe' } })
  return { manager, launches, launch, killTree, cookies, events, publish, cookieCleaned, root }
}
async function settled(manager: YouTubeImportJobManager): Promise<YtImportJob> {
  await vi.waitFor(() => expect(['ready', 'failed', 'cancelled']).toContain(manager.list()[0]?.state))
  return manager.list()[0]!
}

describe('YouTube section imports', () => {
  it.each([
    ['DIRECT to HTTP', { kind: 'direct' }, { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }],
    ['HTTP to DIRECT', { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }, { kind: 'direct' }],
    ['different HTTP proxies', { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }, { kind: 'http', proxyUrl: 'http://127.0.0.1:8123' }],
    ['SOCKS media alternative', { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }, { kind: 'http', proxyUrl: 'http://127.0.0.1:3128', alternatives: [{ kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080' }] }],
    ['HTTP media alternative', { kind: 'direct' }, { kind: 'direct', alternatives: [{ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }] }],
  ] satisfies Array<[string, NetworkRoute, NetworkRoute]>)('uses per-media PAC routes through the gateway for %s', async (_label, probeRoute, mediaRoute) => {
    const network = { route: vi.fn(async (url: string) => url.startsWith('https://www.youtube.com/') ? probeRoute : mediaRoute) }
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>(async () => ({ url: 'http://127.0.0.1:19000/media/opaque', proxyUrl: '' }))
    const h = harness({ network: () => network, mediaInput })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready', format: { videoFormatId: '399', audioFormatId: '251' } })
    expect(mediaInput.mock.calls.map(call => call[0])).toEqual([probeInfo().formats[0]!.url, probeInfo().formats[2]!.url])
    expect(mediaInput.mock.calls.every(call => call[2] === network)).toBe(true)
    expect(h.launches[1]!.args).toContain('-progress')
    expect(h.launches[1]!.args).not.toContain('--proxy')
    expect(h.launches[1]!.args).not.toContain('--download-sections')
    expect(network.route.mock.calls.map(call => call[0])).toEqual([request.url, probeInfo().formats[0]!.url, probeInfo().formats[2]!.url])
    await h.manager.dispose()
  })

  it('routes video and audio independently when only the audio PAC plan differs from the probe', async () => {
    const network = { route: vi.fn(async (url: string): Promise<NetworkRoute> => ({ kind: 'http',
      proxyUrl: url.endsWith('/audio') ? 'http://127.0.0.1:8123' : 'http://127.0.0.1:3128' })) }
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>(async () => ({ url: 'http://127.0.0.1:19000/media/opaque', proxyUrl: '' }))
    const h = harness({ network: () => network, mediaInput })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready' })
    expect(mediaInput).toHaveBeenCalledTimes(2)
    expect(h.launches[1]!.args).not.toContain('--proxy')
    await h.manager.dispose()
  })

  it.each([{ kind: 'direct' }, { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }] satisfies NetworkRoute[])(
    'preserves the existing yt-dlp path for the same %j media plan', async route => {
      const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>()
      const h = harness({ network: () => ({ route: async () => route }), mediaInput })
      h.manager.start(request)
      expect(await settled(h.manager)).toMatchObject({ state: 'ready' })
      expect(h.launches[1]!.args).toContain('--download-sections')
      expect(mediaInput).not.toHaveBeenCalled()
      await h.manager.dispose()
    })

  it.each(['socks4-unsupported', 'proxy-type-unsupported'] as const)('skips an explicit unsupported PAC entry %s before HTTP', async reason => {
    const h = harness({ network: () => ({ route: async () => ({ kind: 'unsupported', reason,
      alternatives: [{ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }],
    }) }) })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready' })
    expect(h.launches[0]!.args.slice(0, 2)).toEqual(['--proxy', 'http://127.0.0.1:3128'])
    expect(h.launches[1]!.args).toContain('--download-sections')
    await h.manager.dispose()
  })

  it('lets a media PAC plan skip unsupported entries before its explicit HTTP candidate', async () => {
    const network = { route: vi.fn(async (url: string): Promise<NetworkRoute> => url.startsWith('https://www.youtube.com/')
      ? { kind: 'direct' } : { kind: 'unsupported', reason: 'socks4-unsupported', alternatives: [{ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }] }) }
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>(async () => ({ url: 'http://127.0.0.1:19000/media/opaque', proxyUrl: '' }))
    const h = harness({ network: () => network, mediaInput })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready' })
    expect(mediaInput).toHaveBeenCalledTimes(2)
    await h.manager.dispose()
  })

  it.each(['socks4-unsupported', 'proxy-type-unsupported'] as const)('reports actionable %s when no supported probe candidate exists', async reason => {
    const h = harness({ network: () => ({ route: async () => ({ kind: 'unsupported', reason }) }) })
    h.manager.start(request)
    const job = await settled(h.manager)
    expect(job).toMatchObject({ state: 'failed', error: { code: reason, message: expect.stringContaining('HTTP 或 SOCKS5') } })
    expect(h.launches).toEqual([])
    await h.manager.dispose()
  })

  it.each(['socks4-unsupported', 'proxy-type-unsupported'] as const)('preserves fixed %s from the media gateway', async code => {
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>(async () => {
      throw new StreamFailureError({ stage: 'proxy', code, message: 'PRIVATE socks5://user:password@proxy.invalid/' })
    })
    const h = harness({ network: () => ({ route: async url => url.startsWith('https://www.youtube.com/')
      ? { kind: 'direct' } : { kind: 'http', proxyUrl: 'http://127.0.0.1:3128' } }), mediaInput })
    h.manager.start(request)
    const job = await settled(h.manager)
    expect(job).toMatchObject({ state: 'failed', error: { code, message: expect.stringContaining('HTTP 或 SOCKS5') } })
    expect(JSON.stringify([job, h.events])).not.toMatch(/PRIVATE|password|proxy\.invalid/)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it.each(['socks4-unsupported', 'proxy-type-unsupported'] as const)('reports actionable %s when the selected media has no usable PAC candidate', async reason => {
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>()
    const h = harness({ network: () => ({ route: async url => url.startsWith('https://www.youtube.com/')
      ? { kind: 'direct' } : { kind: 'unsupported', reason } }), mediaInput })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: reason, message: expect.stringContaining('HTTP 或 SOCKS5') } })
    expect(h.launches).toHaveLength(1)
    expect(mediaInput).not.toHaveBeenCalled()
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })
  it('uses proxy DNS for a SOCKS5 probe and sends only the selected tracks through opaque FFmpeg inputs', async () => {
    const network = { route: vi.fn(async () => ({ kind: 'socks5' as const, proxyUrl: 'socks5://PRIVATE:PRIVATE@127.0.0.1:1080' })) }
    let capability = 0
    const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>(async () => ({ url: `http://127.0.0.1:19000/media/${++capability}`, proxyUrl: '' }))
    const h = harness({ network: () => network, mediaInput })
    h.manager.start(request)
    const job = await settled(h.manager)
    expect(job).toMatchObject({ state: 'ready', format: { videoFormatId: '399', audioFormatId: '251', height: 2160 } })
    expect(h.launches).toHaveLength(3)
    expect(h.launches[0]?.args.slice(0, 2)).toEqual(['--proxy', 'socks5h://PRIVATE:PRIVATE@127.0.0.1:1080'])
    expect(mediaInput.mock.calls.map(call => call[0])).toEqual([probeInfo().formats[0]!.url, probeInfo().formats[2]!.url])
    expect(mediaInput.mock.calls.every(call => call[2] === network)).toBe(true)
    expect(mediaInput.mock.calls.every(call => Object.keys(call[1] ?? {}).every(key => !/cookie|authorization/i.test(key)))).toBe(true)
    const args = h.launches[1]!.args
    expect(args.filter(value => value === '-ss')).toHaveLength(2)
    expect(args[args.indexOf('-ss') + 1]).toBe('40')
    expect(args[args.indexOf('-t') + 1]).toBe('15')
    expect(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 4)).toEqual(['-c:v', 'copy', '-c:a', 'copy'])
    expect(args).not.toContain('--download-sections')
    expect(args.join(' ')).not.toMatch(/PRIVATE|googlevideo|cookies|socks5/)
    const env = h.launches[1]!.options.env as NodeJS.ProcessEnv
    expect(Object.keys(env).filter(key => /^(http|https|all|no)_proxy$/i.test(key))).toEqual([])
    expect(JSON.stringify([job, h.events])).not.toMatch(/PRIVATE|googlevideo|socks5/)
    await h.manager.dispose()
  })

  it('keeps the requested height and fails safely when no SOCKS media gateway was injected', async () => {
    const h = harness({ network: () => ({ route: async () => ({ kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080' }) }) })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'network' } })
    expect(h.launches).toHaveLength(1)
    expect(h.publish).not.toHaveBeenCalled()
    await h.manager.dispose()
  })

  it.each(['https://evil.invalid/video', 'http://media.googlevideo.com/video', 'https://user:PRIVATE@media.googlevideo.com/video'])(
    'refuses unsafe gateway media %s without forwarding credentials', async url => {
      const info = probeInfo(); info.formats[0]!.url = url
      const mediaInput = vi.fn<NonNullable<YtImportOptions['mediaInput']>>()
      const h = harness({ info, mediaInput, network: () => ({ route: async () => ({ kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080' }) }) })
      h.manager.start(request)
      expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'format-unavailable' } })
      expect(mediaInput).not.toHaveBeenCalled()
      expect(h.publish).not.toHaveBeenCalled()
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE')
      await h.manager.dispose()
    })

  it('tries the next PAC probe only after a proven proxy connection failure', async () => {
    const h = harness({ probeFailures: ['Unable to connect to proxy: Connection refused PRIVATE'], network: () => ({ route: async () => ({
      kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080', alternatives: [{ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }],
    }) }), mediaInput: async () => ({ url: 'http://127.0.0.1:19000/media/opaque', proxyUrl: '' }) })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'ready' })
    expect(h.launches[0]!.args.slice(0, 2)).toEqual(['--proxy', 'socks5h://127.0.0.1:1080'])
    expect(h.launches[1]!.args.slice(0, 2)).toEqual(['--proxy', 'http://127.0.0.1:3128'])
    expect(JSON.stringify(h.events)).not.toContain('PRIVATE')
    await h.manager.dispose()
  })

  it.each(['Please sign in', 'HTTP Error 403', 'certificate verify failed'])(
    'does not change the PAC route for %s', async failure => {
      const h = harness({ probeFailures: [failure], network: () => ({ route: async () => ({ kind: 'http',
        proxyUrl: 'http://127.0.0.1:3128', alternatives: [{ kind: 'direct' }],
      }) }) })
      h.manager.start(request)
      expect(await settled(h.manager)).toMatchObject({ state: 'failed' })
      expect(h.launches).toHaveLength(1)
      await h.manager.dispose()
    })
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
    expect(Object.keys(metadata).sort()).toEqual(['downloadedAt', 'endSeconds', 'format', 'mtimeMs', 'sha256', 'size', 'startSeconds', 'title', 'videoId'])
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

  it('accepts a three-hour clip above the former byte cap and restores its metadata', async () => {
    const info = probeInfo(); info.metadata.duration = 20_000
    const h = harness({ info })
    h.manager.start({ ...request, startSeconds: 0, endSeconds: 10_800 })
    const job = await settled(h.manager)
    expect(job.state).toBe('ready')
    const download = h.launches.find(launch => launch.args.includes('--download-sections'))!
    expect(download.args[download.args.indexOf('--download-sections') + 1]).toBe('*0-10800')
    const restored = new YouTubeImportJobManager({ userDataDirectory: h.root, electronPath: '', networkRuntimePath: runtimePath, cookies: h.cookies })
    await restored.initialize()
    expect(restored.list()).toMatchObject([{ state: 'ready', endSeconds: 10_800 }])
    const sidecar = path.join(h.root, 'admin-media', job.jobId, 'metadata.json')
    const metadata = JSON.parse(fs.readFileSync(sidecar, 'utf8'))
    for (const invalid of [{ ...metadata, endSeconds: 10_801 }, { ...metadata, size: 40 * 1024 ** 3 + 1 }]) {
      fs.writeFileSync(sidecar, JSON.stringify(invalid))
      const rejected = new YouTubeImportJobManager({ userDataDirectory: h.root, electronPath: '', networkRuntimePath: runtimePath, cookies: h.cookies })
      await rejected.initialize()
      expect(rejected.list()).toEqual([])
      await rejected.dispose()
    }
    await h.manager.dispose(); await restored.dispose()
  })

  it('accepts progress above 2GiB and terminates progress exceeding 40GiB', async () => {
    const h = harness({ hold: 'download' })
    h.manager.start(request)
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    const download = h.launches[1]!.child
    download.stdout!.emit('data', Buffer.from(`FY1_PROGRESS:[${3 * 1024 ** 3},null,null,null]\n`))
    expect(h.manager.list()[0]).toMatchObject({ state: 'downloading', progress: { downloadedBytes: 3 * 1024 ** 3 } })
    expect(h.killTree).not.toHaveBeenCalled()
    download.stdout!.emit('data', Buffer.from(`FY1_PROGRESS:[${40 * 1024 ** 3 + 1},null,null,null]\n`))
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'disk-full' } })
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(download)
    await h.manager.dispose()
  })

  it.each(['poll', 'completion'] as const)('rejects media larger than 40GiB during %s even without progress output', async stage => {
    const h = harness({ hold: 'download' })
    const job = h.manager.start(request)
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    const file = path.join(h.root, 'admin-media', job.jobId, 'media.mp4')
    fs.writeFileSync(file, 'synthetic bytes')
    const stat = fs.statSync(file); stat.size = 40 * 1024 ** 3 + 1
    const read = vi.spyOn(fs.promises, 'lstat').mockResolvedValueOnce(stat)
    try {
      if (stage === 'completion') h.launches[1]!.child.emit('close', 0)
      await vi.waitFor(() => expect(h.manager.list()[0]).toMatchObject({ state: 'failed', error: { code: 'disk-full' } }), { timeout: 2000 })
      expect(h.publish).not.toHaveBeenCalled()
      if (stage === 'poll') expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.launches[1]!.child)
    } finally { read.mockRestore(); await h.manager.dispose() }
  })

  it.each([[15, 30 * 60_000], [3600, 36_000_000]])('gives %s seconds of footage %s milliseconds to download', async (duration, timeout) => {
    const info = probeInfo(); info.metadata.duration = 20_000
    const h = harness({ hold: 'download', info })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      const job = h.manager.start({ ...request, startSeconds: 0, endSeconds: duration })
      await vi.waitFor(() => expect(h.launches).toHaveLength(2))
      expect(timer.mock.calls.some(call => call[1] === timeout)).toBe(true)
      await h.manager.cancel(job.jobId)
    } finally { timer.mockRestore(); await h.manager.dispose() }
  })

  it('kills the download when its configured timeout expires', async () => {
    const h = harness({ hold: 'download', downloadTimeoutMs: 10 })
    h.manager.start(request)
    expect(await settled(h.manager)).toMatchObject({ state: 'failed', error: { code: 'network' } })
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.launches[1]!.child)
    await h.manager.dispose()
  })

  it('skips unchanged asset hashing, rehashes changed timestamps, and rejects changed contents or sizes', async () => {
    const h = harness()
    h.manager.start(request)
    const job = await settled(h.manager)
    const file = path.join(h.root, 'admin-media', job.jobId, 'media.mp4')
    const sidecar = path.join(h.root, 'admin-media', job.jobId, 'metadata.json')
    const restore = async () => {
      const manager = new YouTubeImportJobManager({ userDataDirectory: h.root, electronPath: '', networkRuntimePath: runtimePath, cookies: h.cookies })
      await manager.initialize()
      return manager
    }
    const read = vi.spyOn(fs, 'createReadStream')
    const restored: YouTubeImportJobManager[] = []
    try {
      restored.push(await restore())
      expect(restored.at(-1)!.list()[0]).toMatchObject({ state: 'ready' })
      expect(read).not.toHaveBeenCalled()
      const previous = fs.statSync(file)
      fs.utimesSync(file, previous.atime, new Date(previous.mtimeMs + 2000))
      restored.push(await restore())
      expect(restored.at(-1)!.list()[0]).toMatchObject({ state: 'ready' })
      expect(read).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fs.readFileSync(sidecar, 'utf8')).mtimeMs).toBe(fs.statSync(file).mtimeMs)
      restored.push(await restore())
      expect(read).toHaveBeenCalledTimes(1)
      const original = fs.readFileSync(file)
      fs.writeFileSync(file, Buffer.alloc(original.length, 120))
      fs.utimesSync(file, previous.atime, new Date(previous.mtimeMs + 4000))
      restored.push(await restore())
      expect(restored.at(-1)!.list()).toEqual([])
      expect(read).toHaveBeenCalledTimes(2)
      fs.appendFileSync(file, 'changed size')
      restored.push(await restore())
      expect(restored.at(-1)!.list()).toEqual([])
      expect(read).toHaveBeenCalledTimes(3)
    } finally { read.mockRestore(); await h.manager.dispose(); await Promise.all(restored.map(manager => manager.dispose())) }
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

  it('rejects more than three hours and invalid intervals without spawning', async () => {
    const h = harness()
    expect(() => h.manager.start({ ...request, endSeconds: 10841 })).toThrow('3 小时')
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

  it('refuses estimated clips exceeding 40GiB', async () => {
    const info = probeInfo(); info.formats[0]!.tbr = 10_000_000
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
    // The independent live run is playable, so it does not need a second client fallback.
    live.stdout!.emit('data', Buffer.from(JSON.stringify({ metadata: { id: videoId, is_live: true }, formats: [
      { format_id: '301', protocol: 'm3u8_native', height: 1080, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/live.m3u8' },
    ] })))
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
