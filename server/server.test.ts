/** Service-level IPC contract tests. No test creates a listening socket. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiResult } from '../src/app/apiClient'
import { packBitmap } from '../src/core/bitmapCodec'
import { createEmptyProfile, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import { createDesktopService, type DesktopService } from './api'
import { resolveConfig, type ProxyConfig } from './config'
import { DanmakuRelay } from './danmaku/relay'
import { MAX_PRESET_BYTES } from './presetStore'

// Public platform DNS is deterministic; no test contacts DNS or an upstream service.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }))

function sampleData(): string {
  return packBitmap(Uint8Array.from({ length: TEMPLATE_PIXELS }, (_, index) => index % 3 === 0 ? 255 : 0))
}

function validProfile(overrides: Record<string, unknown> = {}) {
  return {
    ...createEmptyProfile('cs2/iem', 'IEM Countdown'),
    templates: { '0': [{ id: 's0', data: sampleData(), createdAt: 1, origin: 'editor' }] },
    ...overrides,
  }
}

function value<T = Record<string, any>>(result: ApiResult<unknown>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  return result.value as T
}

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

  it('reports readiness, media setting and current relay count', async () => {
    expect(value(await service.invoke('health', undefined))).toEqual({
      ok: true, version: '0.1.0', proxyEnabled: true, danmakuRooms: 0,
    })
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

  it.each(['health', 'listPresets'])('requires absent arguments for %s', async (method) => {
    expect(await service.invoke(method, {})).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await service.invoke(method, null)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })

  it.each([null, [], 'bad', 42, { token: 12 }, {}, { token: '', extra: true }, { token: 'x'.repeat(4_097) }])('rejects malformed editor verification: %j', async (args) => {
    expect(await service.invoke('verifyAdmin', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })

  it('accepts the trusted local editor without a shared secret', async () => {
    expect(await service.invoke('verifyAdmin', { token: '' })).toEqual({ ok: true, value: { ok: true } })
    expect(await service.invoke('verifyAdmin', { token: 'legacy-test-value' })).toEqual({ ok: true, value: { ok: true } })
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
    it.each([undefined, {}, null, [], { input: 'x', extra: true }, { input: 'x', platform: 'youtube' }, { input: 'x'.repeat(8_193) }])('validates resolver arguments: %j', async (args) => {
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

    it.each(['http://127.0.0.1/a.mp4', 'http://169.254.169.254/a.mp4', 'http://10.0.0.1/a.mp4', 'http://[::1]/a.mp4'])('rejects private media targets before registering: %s', async (input) => {
      expect(await service.invoke('resolve', { input })).toMatchObject({ ok: false, code: 'private-address' })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(registered).toEqual([])
    })

    it('refuses remote media outside the hostname allow list', async () => {
      const other = setup({ proxy: { ...proxy, hosts: ['allowed.example'] } })
      expect(await other.invoke('resolve', { input: 'https://8.8.8.8/video.mp4' })).toMatchObject({ ok: false, code: 'host-not-allowed' })
      expect(registered).toEqual([])
      other.dispose()
    })

    it('refuses nonstandard media ports', async () => {
      expect(await service.invoke('resolve', { input: 'https://8.8.8.8:9000/video.mp4' })).toMatchObject({ ok: false, code: 'bad-port' })
    })

    it('rejects media credentials without echoing them', async () => {
      const result = await service.invoke('resolve', { input: 'https://example-user:example-password@8.8.8.8/video.mp4' })
      expect(result).toMatchObject({ ok: false, code: 'invalid-url' })
      expect(JSON.stringify(result)).not.toContain('example-password')
    })

    it('fetches platform metadata with fixed headers and registers the resulting media', async () => {
      fetchImpl.mockResolvedValue(new Response(JSON.stringify({ error: 0, data: {
        room_id: '288016', room_status: '1', room_name: 'test room', hls_url: 'https://8.8.8.8/index.m3u8',
      } }), { headers: { 'content-type': 'application/json' } }))
      const result = value(await service.invoke('resolve', { input: '288016', platform: 'douyu' }))
      expect(result.stream).toMatchObject({ platform: 'douyu', url: 'app://app/media/test-1', danmakuRoom: '288016', requiresProxy: false })
      expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
        redirect: 'manual', method: 'GET', headers: { accept: 'application/json, text/plain, */*' },
      }))
    })

    it('keeps resolver API targets inside the safeFetch allow list', async () => {
      const other = setup({ proxy: { ...proxy, hosts: ['8.8.8.8'] } })
      expect(value(await other.invoke('resolve', { input: '288016', platform: 'douyu' }))).toMatchObject({ ok: false, failure: { code: 'upstream-error' } })
      expect(fetchImpl).not.toHaveBeenCalled()
      other.dispose()
    })

    it('blocks a resolver redirect into the metadata address', async () => {
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

  describe('preset operations', () => {
    const save = (overrides: Record<string, unknown> = {}, etag?: string) => service.invoke('savePreset', { id: 'cs2/iem', profile: validProfile(overrides), etag })

    it('starts with an empty list', async () => {
      expect(value(await service.invoke('listPresets', undefined))).toEqual({ presets: [] })
    })

    it('creates and reads a nested preset id with an ETag', async () => {
      const saved = value(await save())
      expect(saved).toMatchObject({ id: 'cs2/iem', etag: expect.stringMatching(/^[0-9a-f]{32}$/), updatedAt: expect.any(Number) })
      const read = value(await service.invoke('getPreset', { id: 'cs2/iem' }))
      expect(read).toMatchObject({ profile: { id: 'cs2/iem', name: 'IEM Countdown' }, etag: saved.etag })
    })

    it('allows validated writes without a token for the trusted local editor', async () => {
      expect((await save()).ok).toBe(true)
      expect(await service.invoke('deletePreset', { id: 'cs2/iem' })).toEqual({ ok: true, value: { ok: true } })
    })

    it('accepts an optional legacy token but still validates its shape', async () => {
      expect((await service.invoke('savePreset', { id: 'cs2/iem', profile: validProfile(), token: '' })).ok).toBe(true)
      expect(await service.invoke('deletePreset', { id: 'cs2/iem', token: 12 })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    })

    it('lists summaries without template bitmap payloads', async () => {
      await save()
      const result = value(await service.invoke('listPresets', undefined))
      expect(result.presets).toHaveLength(1)
      expect(result.presets[0]).toMatchObject({ id: 'cs2/iem', name: 'IEM Countdown', templateChars: 1 })
      expect(JSON.stringify(result)).not.toContain(sampleData())
    })

    it('returns not-found for an unknown preset', async () => {
      expect(await service.invoke('getPreset', { id: 'cs2/absent' })).toMatchObject({ ok: false, code: 'not-found' })
    })

    it('returns validation paths for an invalid profile', async () => {
      expect(await save({ matchThreshold: 5 })).toMatchObject({
        ok: false, code: 'invalid-profile', detail: { issues: expect.arrayContaining([expect.objectContaining({ path: 'matchThreshold' })]) },
      })
    })

    it('returns currentEtag on a stale write and preserves newer data', async () => {
      const first = value(await save())
      const second = value(await save({ name: 'Second' }))
      expect(second.etag).not.toBe(first.etag)
      expect(await save({ name: 'Third' }, first.etag)).toMatchObject({ ok: false, code: 'conflict', detail: { currentEtag: second.etag } })
      expect(value(await service.invoke('getPreset', { id: 'cs2/iem' })).profile.name).toBe('Second')
    })

    it('accepts the current ETag and returns the next one', async () => {
      const first = value(await save())
      const updated = value(await save({ name: 'Renamed' }, first.etag))
      expect(updated.etag).not.toBe(first.etag)
    })

    it('rejects a profile larger than the preset limit', async () => {
      expect(await save({ notes: 'x'.repeat(MAX_PRESET_BYTES) })).toMatchObject({ ok: false, code: 'too-large' })
    })

    it('rejects oversized IPC envelopes', async () => {
      expect(await save({ notes: 'x'.repeat(MAX_PRESET_BYTES + 20_000) })).toMatchObject({ ok: false, code: 'too-large' })
    })

    it('deletes once and then reports the preset gone', async () => {
      await save()
      expect((await service.invoke('deletePreset', { id: 'cs2/iem' })).ok).toBe(true)
      expect(await service.invoke('deletePreset', { id: 'cs2/iem' })).toMatchObject({ ok: false, code: 'not-found' })
      expect(value(await service.invoke('listPresets', undefined)).presets).toEqual([])
    })

    it.each(['../escaped', 'cs2/../../escaped', 'a'.repeat(66), '', 'a\\b', 'a%2Fb'])('rejects unsafe preset ids on all operations: %s', async (id) => {
      for (const method of ['getPreset', 'deletePreset', 'savePreset']) {
        const args = method === 'savePreset' ? { id, profile: validProfile() } : { id }
        expect(await service.invoke(method, args)).toMatchObject({ ok: false, code: 'invalid-id' })
      }
    })

    it.each([{ id: 'cs2/iem' }, { id: 'cs2/iem', profile: validProfile(), extra: true }, { id: 'cs2/iem', profile: validProfile(), etag: 1 }, { id: 'cs2/iem', profile: validProfile(), token: [] }])('rejects malformed save envelopes', async (args) => {
      expect(await service.invoke('savePreset', args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    })

    it('rejects a non-profile without disrupting subsequent calls', async () => {
      expect(await service.invoke('savePreset', { id: 'cs2/iem', profile: [] })).toMatchObject({ ok: false, code: 'invalid-profile' })
      expect(value(await service.invoke('health', undefined)).ok).toBe(true)
    })

    it('keeps I/O errors structured and hides local paths', async () => {
      const file = join(dataDir, 'file-not-directory')
      await writeFile(file, 'occupied', 'utf8')
      const other = setup({ dataDir: file })
      const result = await other.invoke('savePreset', { id: 'cs2/iem', profile: validProfile() })
      expect(result).toMatchObject({ ok: false, code: 'io-error' })
      expect(JSON.stringify(result)).not.toContain(dataDir)
      other.dispose()
    })
  })

  it('returns a stable error after disposal', async () => {
    service.dispose()
    expect(await service.invoke('health', undefined)).toMatchObject({ ok: false, code: 'service-closed' })
  })
})
