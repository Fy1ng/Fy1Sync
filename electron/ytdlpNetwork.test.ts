import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkContext, NetworkRoute } from '../server/networkPolicy'
import { locateYouTubePotProvider } from './toolLocator'
import { prepareScriptOnlyPotPlugin, readScriptOnlyPluginZip } from './potPlugin'
import { YtDlpRunner } from './ytdlp'
import youtubeFixture from '../server/platforms/fixtures/youtube-live.json'

vi.mock('./toolLocator', async actual => ({ ...await actual<object>(), locateTool: vi.fn(async () => '/fixture/yt-dlp.exe'),
  locateYouTubePotProvider: vi.fn(async () => undefined) }))
vi.mock('./potPlugin', async actual => ({ ...await actual<object>(), prepareScriptOnlyPotPlugin: vi.fn() }))

const runners: YtDlpRunner[] = []
beforeEach(() => {
  vi.mocked(locateYouTubePotProvider).mockReset().mockResolvedValue(undefined)
  vi.mocked(prepareScriptOnlyPotPlugin).mockReset().mockResolvedValue({ pluginDir: '/fixture/script-only', dispose: async () => {} })
})
afterEach(async () => { await Promise.all(runners.splice(0).map(runner => runner.dispose())) })

const inherited: NodeJS.ProcessEnv = {
  PATH: 'fixture-path', NODE_OPTIONS: '--trace-warnings',
  http_proxy: 'http://inherited.invalid:1001', HTTP_PROXY: 'http://inherited.invalid:1002',
  https_proxy: 'http://inherited.invalid:1003', HTTPS_PROXY: 'http://inherited.invalid:1004',
  all_proxy: 'socks5://inherited.invalid:1005', ALL_PROXY: 'socks5://inherited.invalid:1006',
  no_proxy: '*', NO_PROXY: '*', Http_Proxy: 'http://inherited.invalid:1007',
}
function harness() {
  const launches: { file: string; args: string[]; options: SpawnOptions; child: ChildProcess }[] = []
  const launch = ((file: string, args: string[], options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() }) as unknown as ChildProcess
    launches.push({ file, args, options, child })
    return child
  }) as unknown as typeof spawn
  const env = { ...inherited }
  const runner = new YtDlpRunner({ electronPath: '/fixture/electron.exe', networkRuntimePath: path.resolve('.runtime-cache/codex-network-impl-20261030-implementation/network-runtime.cjs'),
    env, spawn: launch, killTree: async child => { child.emit('close', 1) },
    cookies: { withTemporaryCookies: async (_platform, callback) => callback(undefined) }, timeoutMs: 2000 })
  runners.push(runner)
  const finish = () => {
    for (const { child } of launches) {
      child.stdout!.emit('data', Buffer.from(JSON.stringify({ metadata: { id: 'abcdefghijk', is_live: true }, formats: youtubeFixture.formats })))
      child.emit('close', 0)
    }
  }
  return { runner, launches, finish, env }
}

describe('explicit yt-dlp and provider route ownership', () => {
  it.each([
    ['DIRECT', { kind: 'direct' }, ''],
    ['HTTP', { kind: 'http', proxyUrl: 'http://fixture-user:fixture-password@127.0.0.1:3128' }, 'http://fixture-user:fixture-password@127.0.0.1:3128'],
    ['SOCKS5', { kind: 'socks5', proxyUrl: 'socks5://fixture-user:fixture-password@127.0.0.1:1080' }, 'socks5h://fixture-user:fixture-password@127.0.0.1:1080'],
  ] as const)('passes %s explicitly and removes inherited proxy variables', async (_label, selected, expected) => {
    const h = harness()
    const route = vi.fn(async (): Promise<NetworkRoute> => selected)
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, { route })
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    const { args, options } = h.launches[0]!
    expect(args.slice(0, 2)).toEqual(['--proxy', expected])
    expect(args.filter(value => value === '--proxy')).toHaveLength(1)
    expect(route).toHaveBeenCalledExactlyOnceWith('https://www.youtube.com/watch?v=abcdefghijk')
    const env = options.env!
    expect(env.PATH).toBe('fixture-path')
    expect(env.NODE_OPTIONS).toContain('--trace-warnings --require=')
    expect(options).toMatchObject({ shell: false, windowsHide: true })
    const proxyKeys = Object.keys(env).filter(name => /^(http|https|all|no)_proxy$/i.test(name))
    expect(proxyKeys.sort()).toEqual(expected ? ['ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY'] : [])
    if (expected) for (const name of proxyKeys) expect(env[name]).toBe(expected)
    expect(JSON.stringify(env)).not.toContain('inherited.invalid')
    expect(h.env).toEqual(inherited)
    h.finish(); await pending
  })

  it.each([
    { kind: 'direct' as const },
    { kind: 'http' as const, proxyUrl: 'http://127.0.0.1:3128' },
  ])('freezes one %j decision for both HLS and adaptive provider child trees', async selected => {
    vi.mocked(locateYouTubePotProvider).mockResolvedValue({ pluginDir: '/fixture/plugin', serverHome: '/fixture/provider' })
    const h = harness()
    const route = vi.fn(async (): Promise<NetworkRoute> => selected)
    const network: NetworkContext = { route }
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', true, network)
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    const expected = selected.kind === 'http' ? selected.proxyUrl : ''
    expect(h.launches.some(item => item.args.includes('--plugin-dirs'))).toBe(true)
    expect(h.launches.some(item => !item.args.includes('--plugin-dirs'))).toBe(true)
    for (const item of h.launches) {
      expect(item.args.slice(0, 2)).toEqual(['--proxy', expected])
      expect(item.options.env!.HTTP_PROXY ?? '').toBe(expected)
      expect(item.options.env!.HTTPS_PROXY ?? '').toBe(expected)
      expect(item.options.env!.ALL_PROXY ?? '').toBe(expected)
      expect(item.options.env!.NO_PROXY).toBeUndefined()
      expect(item.options.env!.no_proxy).toBeUndefined()
      expect(item.options.env!.ELECTRON_RUN_AS_NODE).toBe('1')
    }
    expect(h.launches[0]!.options.env).toEqual(h.launches[1]!.options.env)
    expect(route).toHaveBeenCalledTimes(1)
    h.finish(); await pending
  })

  it('keeps anonymous Huya extractor retries on the supplied acquisition route too', async () => {
    const h = harness()
    const selected = 'http://127.0.0.1:3128'
    const pending = h.runner.resolve('https://www.huya.com/123456', false, { route: async () => ({ kind: 'http', proxyUrl: selected }) })
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    expect(h.launches[0]!.args.slice(0, 2)).toEqual(['--proxy', selected])
    expect(h.launches[0]!.options.env!.HTTP_PROXY).toBe(selected)
    expect(locateYouTubePotProvider).not.toHaveBeenCalled()
    h.finish(); await pending
  })

  it('does not turn an unsupported system proxy into an implicit DIRECT route', async () => {
    const h = harness()
    await expect(h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, {
      route: async () => ({ kind: 'unsupported', reason: 'socks4-unsupported' }),
    })).rejects.toMatchObject({ failure: { stage: 'proxy', code: 'proxy-type-unsupported' } })
    expect(h.launches).toEqual([])
  })
  it('skips an unsupported PAC item only when the system explicitly supplied a later route', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, {
      route: async () => ({ kind: 'unsupported', reason: 'socks4-unsupported', alternatives: [{ kind: 'direct' }] }),
    })
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    expect(h.launches[0]!.args.slice(0, 2)).toEqual(['--proxy', ''])
    h.finish(); await pending
  })

  it('tries only the next declared PAC route after a confirmed proxy connection failure', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, { route: async () => ({
      kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080', alternatives: [{ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }, { kind: 'direct' }],
    }) })
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.launches[0]!.child.stderr!.emit('data', Buffer.from('Unable to connect to proxy: Connection refused PRIVATE'))
    h.launches[0]!.child.emit('close', 1)
    await vi.waitFor(() => expect(h.launches).toHaveLength(2))
    expect(h.launches.map(item => item.args.slice(0, 2))).toEqual([
      ['--proxy', 'socks5h://127.0.0.1:1080'], ['--proxy', 'http://127.0.0.1:3128'],
    ])
    h.finish(); await pending
    expect(h.launches).toHaveLength(2)
  })

  it.each(['HTTP Error 403: Forbidden', 'Sign in to confirm you are not a bot', 'certificate verify failed', 'Proxy authentication failed: 407'])(
    'keeps the selected route for an upstream or authentication failure: %s', async text => {
      const h = harness()
      const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, { route: async () => ({
        kind: 'socks5', proxyUrl: 'socks5://127.0.0.1:1080', alternatives: [{ kind: 'direct' }],
      }) }).catch(error => error)
      await vi.waitFor(() => expect(h.launches).toHaveLength(1))
      h.launches[0]!.child.stderr!.emit('data', Buffer.from(text))
      h.launches[0]!.child.emit('close', 1)
      const error = await pending
      expect(error).toBeInstanceOf(Error)
      expect(h.launches).toHaveLength(1)
    })

  it('attributes an explicitly proxied extraction connection refusal to the proxy', async () => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, {
      route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }),
    }).catch(error => error)
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.launches[0]!.child.stderr!.emit('data', Buffer.from('Unable to download webpage: Connection refused https://fixture.invalid/?token=PRIVATE Cookie=PRIVATE'))
    h.launches[0]!.child.emit('close', 1)
    const error = await pending
    expect(error).toMatchObject({ failure: { stage: 'proxy', code: 'proxy-unreachable' } })
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|token=|Cookie/)
  })

  it.each([
    ['HTTP Error 403: Forbidden', 'http', 'http-403'],
    ['certificate verify failed', 'connect', 'tls-certificate'],
  ])('preserves target HTTP or certificate failure through the selected proxy: %s', async (text, stage, code) => {
    const h = harness()
    const pending = h.runner.resolve('https://www.youtube.com/watch?v=abcdefghijk', false, {
      route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:3128' }),
    }).catch(error => error)
    await vi.waitFor(() => expect(h.launches).toHaveLength(1))
    h.launches[0]!.child.stderr!.emit('data', Buffer.from(`${text} https://fixture.invalid/?token=PRIVATE Cookie=PRIVATE`))
    h.launches[0]!.child.emit('close', 1)
    const error = await pending
    expect(error).toMatchObject({ failure: { stage, code } })
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|token=|Cookie/)
  })
})

describe('bundled provider proxy compatibility', () => {
  const plugin = path.resolve('.packaging/tools/provider/plugin/bgutil-ytdlp-pot-provider.zip')
  const server = path.resolve('.packaging/tools/provider/server/build')
  it.skipIf(!existsSync(plugin) || !existsSync(path.join(server, 'session_manager.js')))(
    'forwards request_proxy to the one-shot script and keeps DIRECT free of environment fallback', async () => {
      const archive = readScriptOnlyPluginZip(await readFile(plugin))
      const script = archive.get('yt_dlp_plugins/extractor/getpot_bgutil_script.py')!.toString('utf8')
      expect(script).toMatch(/if proxy := request\.request_proxy:\s+command_args\.extend\(\['-p', proxy\]\)/)
      expect(script).toMatch(/def _jsrt_envs\(self\) -> dict:\s+return os\.environ\.copy\(\)/)
      expect(script).toMatch(/command_args, env=self\._jsrt_envs\(\)/)
      const once = await readFile(path.join(server, 'generate_once.js'), 'utf8')
      expect(once).toContain('.option("-p, --proxy <proxy-all>")')
      expect(once).toContain('const proxy = options.proxy || "";')
      expect(once).toContain('generatePoToken(contentBinding, proxy,')
      const manager = await readFile(path.join(server, 'session_manager.js'), 'utf8')
      expect(manager).toMatch(/if \(proxy\)\s*\{\s*pxySpec\.proxy = proxy;/)
      expect(manager).toMatch(/process\.env\.HTTPS_PROXY\s*\|\|\s*process\.env\.HTTP_PROXY\s*\|\|\s*process\.env\.ALL_PROXY/)
      expect(manager).toContain('getProxyForUrl: () => pxyStr')
      expect(manager).toContain('proxy: false')
      expect(manager).toContain('rejectUnauthorized: !disableTlsVerification')
    })
})
