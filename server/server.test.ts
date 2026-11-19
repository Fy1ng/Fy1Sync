/** Service-level IPC contract tests. No test creates a listening socket. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import appPackage from '../package.json'
import type { ApiResult } from '../src/app/apiClient'
import { createDesktopService, createResolverDeps, sanitizedFailure, type DesktopService, type AcquisitionService } from './api'
import { StreamFailureError } from './networkFailure'
import { ProxyError } from './safeFetch'
import { resolveConfig, type ProxyConfig } from './config'
import { DanmakuRelay } from './danmaku/relay'
import { MAX_PLATFORM_RESPONSE_BYTES } from './platformResponse'

// Public platform DNS is deterministic; no test contacts DNS or an upstream service.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))

function value<T = Record<string, any>>(result: ApiResult<unknown>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result.value as T
}

describe('platform metadata request limits', () => {
  it('posts binary WUP metadata and preserves binary responses without UTF-8 decoding', async () => {
    const body = new Uint8Array([0, 0x80, 0xff])
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body))
    const deps = createResolverDeps(resolveConfig({}).proxy, url => url, fetchImpl)
    expect(await deps.fetchBytes('https://wup.huya.com', { method: 'POST', body,
      headers: { Referer: 'https://www.huya.com/', 'Content-Type': 'application/octet-stream' } })).toEqual(body)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST', body,
      headers: { Referer: 'https://www.huya.com/', 'Content-Type': 'application/octet-stream' } })
  })
  it('cancels an oversized HTTP success body without returning its payload', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_PLATFORM_RESPONSE_BYTES + 1))
    }, cancel }))
    const deps = createResolverDeps(resolveConfig({}).proxy, url => url, vi.fn(async () => response))
    await expect(deps.fetchText('https://www.douyu.com/api')).rejects.toHaveProperty('name', 'StreamFailureError')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels rejected responses and never includes upstream text in JSON parse errors', async () => {
    const cancel = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 500 }))
      .mockResolvedValueOnce(new Response('synthetic-private-upstream-text'))
    const deps = createResolverDeps(resolveConfig({}).proxy, url => url, fetchImpl)
    await expect(deps.fetchJson('https://www.douyu.com/api')).rejects.toHaveProperty('name', 'StreamFailureError')
    expect(cancel).toHaveBeenCalledOnce()
    await expect(deps.fetchJson('https://www.douyu.com/api')).rejects.toThrow('平台返回的数据格式无效')
  })
})

describe('public stream failure wording', () => {
  it.each([
    ['connect', 'dns-failed', '域名解析失败'],
    ['proxy', 'proxy-unreachable', '无法连接取流代理'],
    ['connect', 'tls-certificate', '服务器证书校验失败'],
    ['http', 'http-403', '服务器返回 HTTP 403'],
    ['connect', 'connection-timeout', '网络连接超时'],
    ['playback-not-ready', 'media-format-invalid', '媒体格式无效或返回的内容不是可播放视频'],
    ['resolve', 'policy-rejected', '媒体地址被应用的安全策略拒绝'],
  ] as const)('keeps %s/%s while discarding provider text', (stage, reason, message) => {
    const result = sanitizedFailure({ ok: false, failure: { code: 'upstream-error', stage, reason,
      message: 'Cookie=PRIVATE https://signed.invalid/?token=PRIVATE', hint: 'original provider hint' } })
    expect(result).toMatchObject({ ok: false, failure: { stage, reason, message, hint: expect.any(String) } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    if (!result.ok) expect(result.failure.detail?.hint).toBe('original provider hint')
  })
})

describe('desktop main-process service', () => {
  let dataDir: string
  let service: DesktopService
  let proxy: ProxyConfig
  let registered: string[]
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>

  function setup(overrides: Partial<Parameters<typeof createDesktopService>[0]> = {}) {
    return createDesktopService({
      dataDir, proxy, fetchImpl,
      registerMedia: (url) => { registered.push(url); return `app://app/media/test-${registered.length}` },
      ...overrides,
    })
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'stream-sync-desktop-'))
    proxy = { ...resolveConfig({}).proxy, hosts: ['*'] }
    registered = []
    fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected network request') })
    service = setup()
  })

  afterEach(async () => {
    service.dispose()
    await rm(dataDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('validates the narrow room query and returns canonical identity without media acquisition', async () => {
    for (const args of [undefined, { input: 6657 }, { input: '6657', url: 'https://evil.invalid' }]) {
      expect(await service.invoke('resolveDouyuRoom', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValueOnce(new Response('<script id="vike_pageContext" type="application/json">' + JSON.stringify({ pageProps: { room: { roomInfo: { roomInfo: { rid: 6979222 } } } } }) + '</script>'))
    expect(await service.invoke('resolveDouyuRoom', { input: '6657' })).toMatchObject({ ok: true, value: { ok: true, identity: { room: '6979222', inputRoom: '6657' } } })
    expect(registered).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports readiness, media setting and current relay count', async () => {
    expect(value(await service.invoke('health', undefined))).toEqual({
      ok: true, version: appPackage.version, proxyEnabled: true, danmakuRooms: 0,
    })
  })

  it('dispatches only validated Douyin actions with a live IPC subscription guard', async () => {
    const state = vi.fn(async () => ({ loggedIn:true, canSend:true, uid:'12345', message:'可发送' }))
    const send = vi.fn(async () => ({ status:'accepted' as const, message:'已受理',nextAllowedAt:null }))
    const other = setup({ douyinMessages:{ state,send } })
    try {
      expect(await other.invoke('getDouyinSendState',undefined)).toMatchObject({ ok:true,value:{ uid:'12345' } })
      expect(state).toHaveBeenLastCalledWith(undefined,false)
      expect(await other.invoke('getDouyinSendState',{ refresh:true })).toMatchObject({ ok:true,value:{ uid:'12345' } })
      expect(state).toHaveBeenLastCalledWith(undefined,true)
      expect(await other.invoke('getDouyinSendState',{ url:'https://evil.invalid' })).toMatchObject({ code:'invalid-arguments' })
      for (const args of [null,[],{},true,{ refresh:false },{ refresh:true,cookie:'synthetic-secret' }]) {
        expect(await other.invoke('getDouyinSendState',args)).toMatchObject({ code:'invalid-arguments' })
      }
      const input = { room:'douyin:100', expectedUid:'12345', text:'测试' }
      expect(await other.invoke('sendDouyinMessage',input)).toMatchObject({ code:'room-changed' })
      for (const args of [{ ...input,room:'100' },{ ...input,text:'x'.repeat(51) },{ ...input,cookie:'secret' }]) {
        expect(await other.invoke('sendDouyinMessage',args,{ isCurrent:() => true })).toMatchObject({ code:'invalid-arguments' })
      }
      expect(send).not.toHaveBeenCalled()
      const isCurrent = () => true
      expect(await other.invoke('sendDouyinMessage',input,{ isCurrent })).toMatchObject({ ok:true,value:{ status:'accepted' } })
      expect(send).toHaveBeenCalledExactlyOnceWith(input,undefined,isCurrent)
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { other.dispose() }
  })

  it('accepts Huya at the resolve IPC boundary without starting a Douyu relay', async () => {
    fetchImpl.mockResolvedValueOnce(new Response('找不到这个主播'))
    expect(await service.invoke('resolve', { input: '12345', platform: 'huya', role: 'commentary' }))
      .toMatchObject({ ok: true, value: { ok: false, failure: { code: 'room-not-found' } } })
    expect(service.relay.roomCount).toBe(0)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('uses the injected relay and closes its rooms when disposed', () => {
    const relay = new DanmakuRelay()
    const close = vi.spyOn(relay, 'closeAll')
    const other = setup({ relay })
    expect(other.relay).toBe(relay)
    other.dispose()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports disabled media loading accurately', async () => {
    const other = setup({ proxy: { ...proxy, enabled: false } })
    expect(value(await other.invoke('health', undefined)).proxyEnabled).toBe(false)
    other.dispose()
  })

  it.each([undefined, null, 12, {}, 'unknown', '/api/health', 'constructor', '__proto__'])('rejects an unlisted method: %j', async (method) => {
    expect(await service.invoke(method, undefined)).toMatchObject({ ok: false, code: 'not-found' })
  })

  it.each(['health', 'getNetworkPreferences'])('requires absent arguments for %s', async (method) => {
    expect(await service.invoke(method, {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await service.invoke(method, null)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })

  it('rejects cyclic, executable and excessively deep argument values', async () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'input', { get: () => { throw new Error('Must not execute') } })
    let deep: unknown = 'leaf'
    for (let index = 0; index < 40; index += 1) deep = { deep }
    for (const args of [cyclic, accessor, { value: BigInt(1) }, { value: () => {} }, { value: new Date() }, deep]) {
      expect(await service.invoke('resolve', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(value(await service.invoke('health', undefined)).ok).toBe(true)
  })

  describe('stream resolution and registration', () => {
    it.each([
      [new ProxyError('dns-failed', 'Cookie=PRIVATE https://signed.invalid/?token=PRIVATE'), 'dns-failed', '域名解析失败'],
      [new ProxyError('too-many-redirects', 'redirect diagnostic'), 'too-many-redirects', '服务器重定向次数过多，请稍后重试'],
      [new ProxyError('upstream-failed', 'upstream diagnostic'), 'upstream-failed', '媒体服务器请求失败，请稍后重试'],
    ])('shows the actual resolve error without echoing sensitive diagnostics', async (error, code, message) => {
      const acquisition = { resolve: vi.fn(async () => { throw error }), switchQuality: vi.fn(async () => { throw error }) } as unknown as AcquisitionService
      const other = setup({ acquisition })
      for (const [method, args] of [['resolve', { input: '6657', platform: 'douyu' }], ['switchQuality', { role: 'official', quality: '0' }]] as const) {
        const result = await other.invoke(method, args)
        expect(result).toMatchObject({ ok: false, code, message })
        expect(JSON.stringify(result)).not.toContain('PRIVATE')
        expect(result).toHaveProperty('detail')
      }
      other.dispose()
    })
    it('preserves a structured network failure thrown by acquisition', async () => {
      const acquisition = { resolve: vi.fn(async () => { throw new StreamFailureError({ stage: 'connect', code: 'tls-certificate', message: 'certificate diagnostic Cookie=PRIVATE' }) }) } as unknown as AcquisitionService
      const other = setup({ acquisition })
      const result = await other.invoke('resolve', { input: '6657', platform: 'douyu' })
      expect(result).toMatchObject({ ok: true, value: { ok: false, failure: { stage: 'connect', reason: 'tls-certificate', message: '服务器证书校验失败' } } })
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      other.dispose()
    })
    it.each([undefined, {}, null, [], { input: 'x', extra: true }, { input: 'x', platform: 'unsupported' }, { input: 'x'.repeat(256 * 1024 + 1) }])('validates resolver arguments: %j', async (args) => {
      expect(await service.invoke('resolve', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    })

    it.each(['', '   ', 12, null])('requires a nonblank string input: %j', async (input) => {
      expect(await service.invoke('resolve', { input })).toMatchObject({ ok: false, code: 'missing-input' })
    })

    it('registers direct media without fetching its bytes', async () => {
      const result = value(await service.invoke('resolve', { input: 'https://8.8.8.8/live.m3u8' }))
      expect(result).toMatchObject({ ok: true, stream: { url: 'app://app/media/test-1', kind: 'hls', requiresProxy: false } })
      expect(registered).toEqual(['https://8.8.8.8/live.m3u8'])
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('registers an explicitly selected direct progressive stream', async () => {
      const result = value(await service.invoke('resolve', { input: 'https://8.8.8.8/watch', platform: 'direct' }))
      expect(result.stream).toMatchObject({ kind: 'progressive', url: 'app://app/media/test-1' })
    })

    it('keeps platform refusal distinct from a transport failure', async () => {
      expect(value(await service.invoke('resolve', { input: 'not a platform' }))).toMatchObject({
        ok: false, failure: { code: 'unsupported-url', message: expect.any(String) },
      })
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each(['/test-sources/official/index.m3u8', '/test-sources/official.mp4'])('allows the safe local fixture path %s', async (input) => {
      expect(value(await service.invoke('resolve', { input, platform: 'direct' }))).toMatchObject({ ok: true, stream: { url: input } })
      expect(registered).toEqual([])
    })

    it.each(['/test-sources/../private.mp4', '/test-sources/%2e%2e/private.mp4', '//evil.test/video.mp4', 'app://app/private.mp4', 'file:///private.mp4', '/other/video.mp4'])('rejects unsafe local or app paths: %s', async (input) => {
      expect(value(await service.invoke('resolve', { input, platform: 'direct' })).ok).toBe(false)
      expect(registered).toEqual([])
    })

    it('permits user-selected media independently of the API hostname allow list', async () => {
      const other = setup({ proxy: { ...proxy, hosts: ['allowed.example'] } })
      expect(await other.invoke('resolve', { input: 'https://custom.example/video.mp4' })).toMatchObject({ ok: true, value: { ok: true } })
      expect(registered).toEqual(['https://custom.example/video.mp4'])
      other.dispose()
    })

    it('accepts nonstandard media ports', async () => {
      expect(await service.invoke('resolve', { input: 'https://8.8.8.8:9000/video.mp4' })).toMatchObject({ ok: true, value: { ok: true } })
    })

    it('keeps media credentials in the registration and excludes them from the public stream', async () => {
      const registerMedia = vi.fn(() => 'app://app/media/auth-fixture')
      const other = setup({ registerMedia })
      const result = await other.invoke('resolve', { input: 'https://example-user:example-password@8.8.8.8/video.mp4' })
      expect(result).toMatchObject({ ok: true, value: { ok: true, stream: { url: 'app://app/media/auth-fixture' } } })
      expect(JSON.stringify(result)).not.toMatch(/example-password|Authorization/)
      expect(registerMedia).toHaveBeenCalledWith('https://8.8.8.8/video.mp4', undefined,
        { Authorization: `Basic ${Buffer.from('example-user:example-password').toString('base64')}` })
      other.dispose()
    })

    it('fetches platform metadata with fixed headers and registers the resulting media', async () => {
      fetchImpl.mockResolvedValueOnce(new Response('<script id="vike_pageContext" type="application/json">' + JSON.stringify({ pageProps: { room: { roomInfo: { roomInfo: { rid: 288016 } } } } }) + '</script>'))
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: 0, data: {
        rand_str: 'seed', key: 'key', enc_time: 1, is_special: 0, enc_data: 'encrypted',
      } }), { headers: { 'content-type': 'application/json' } }))
      fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: 0, data: {
        rtmp_url: 'https://8.8.8.8', rtmp_live: 'index.m3u8', rate: 0, multirates: [{ rate: 0, name: '原画' }],
      } }), { headers: { 'content-type': 'application/json' } }))
      const result = value(await service.invoke('resolve', { input: '288016', platform: 'douyu' }))
      expect(result.stream).toMatchObject({ platform: 'douyu', url: 'app://app/media/test-1', danmakuRoom: '288016', requiresProxy: false })
      expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
        redirect: 'manual', method: 'POST', headers: expect.objectContaining({ Referer: 'https://www.douyu.com/' }),
      }))
    })

    it('keeps resolver API targets inside the safeFetch allow list', async () => {
      const other = setup({ proxy: { ...proxy, hosts: ['8.8.8.8'] } })
      expect(value(await other.invoke('resolve', { input: '288016', platform: 'douyu' }))).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
      expect(fetchImpl).not.toHaveBeenCalled()
      other.dispose()
    })

    it('blocks a resolver redirect outside the allowed hostname', async () => {
      fetchImpl.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }))
      expect(value(await service.invoke('resolve', { input: '288016', platform: 'douyu' }))).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('does not expose upstream exceptions or signed URLs', async () => {
      fetchImpl.mockRejectedValue(new Error('https://private.invalid/?signature=do-not-echo'))
      const result = await service.invoke('resolve', { input: '288016', platform: 'douyu' })
      expect(value(result)).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
      expect(JSON.stringify(result)).not.toContain('do-not-echo')
    })
  })

  it('returns a stable error after disposal', async () => {
    service.dispose()
    expect(await service.invoke('health', undefined)).toMatchObject({ ok: false, code: 'service-closed' })
  })
})
