import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { NetworkPolicy } from '../server/networkPolicy'
import { DEFAULT_MEDIA_NETWORK } from '../server/mediaNetworkOptions'
import { NetworkPreferences } from './networkPreferences'

const root = os.tmpdir()
async function directory() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'network-preferences-')) }

describe('persistent domestic network preferences', () => {
  it('persists per-origin headers, trust and stream limits without sharing mutable rule objects', async () => {
    const location = await directory(), preferences = new NetworkPreferences(location)
    const media = { ...DEFAULT_MEDIA_NETWORK, sourceRules: [{ origin: 'https://media.invalid:8443', headers: { Authorization: 'Bearer synthetic' }, verifyTls: false, verifyProxyTls: true }], maxExtraStreams: 300 }
    await preferences.set('direct', media)
    media.sourceRules[0]!.headers.Authorization = 'mutated'
    const loaded = new NetworkPreferences(location)
    expect(loaded.mediaOptions()).toMatchObject({ sourceRules: [{ headers: { Authorization: 'Bearer synthetic' } }], maxExtraStreams: 300 })
    const snapshot = loaded.mediaOptions()
    snapshot.sourceRules![0]!.headers.Authorization = 'another mutation'
    expect(loaded.mediaOptions().sourceRules![0]!.headers.Authorization).toBe('Bearer synthetic')
    expect(loaded.extraStreamLimit()).toBe(300)
  })
  it('keeps playback settings editable when system proxy discovery fails', async () => {
    const preferences = new NetworkPreferences(await directory())
    preferences.attach(new NetworkPolicy(async () => { throw new Error('fixture') }, () => 'system'))
    expect(await preferences.get()).toMatchObject({ media: DEFAULT_MEDIA_NETWORK, systemProxy: { fallbackReason: 'proxy-resolution-failed' } })
    expect(await preferences.set('direct', { ...DEFAULT_MEDIA_NETWORK, routing: 'direct' })).toMatchObject({ media: { routing: 'direct' } })
  })
  it('migrates the old route setting and persists playback options independently', async () => {
    const location = await directory()
    await writeFile(path.join(location, 'network-preferences.json'), JSON.stringify({ version: 1, domesticRouting: 'system' }))
    const preferences = new NetworkPreferences(location)
    expect(preferences.domesticRouting()).toBe('system')
    expect(preferences.mediaOptions()).toEqual(DEFAULT_MEDIA_NETWORK)
    const media = { ...DEFAULT_MEDIA_NETWORK, routing: 'custom' as const, proxyUrl: 'http://127.0.0.1:7890', requestTimeoutMs: 9000 }
    await preferences.set('system', media)
    media.requestTimeoutMs = 100
    await preferences.set('direct')
    const loaded = new NetworkPreferences(location)
    expect(loaded.domesticRouting()).toBe('direct')
    expect(loaded.mediaOptions()).toMatchObject({ routing: 'custom', requestTimeoutMs: 9000 })
    await expect(preferences.set('system', { ...DEFAULT_MEDIA_NETWORK, routing: 'custom' })).rejects.toThrow('Invalid media network options')
    expect(preferences.domesticRouting()).toBe('direct')
  })
  it('defaults to domestic direct without touching disk', async () => {
    const location = await directory()
    expect(await new NetworkPreferences(location).get()).toEqual({ domesticRouting: 'direct', media: DEFAULT_MEDIA_NETWORK, systemProxy: { type: 'direct' } })
    expect(await readdir(location)).toEqual([])
  })

  it('persists the chosen mode atomically and reloads it after restart', async () => {
    const location = await directory()
    const preferences = new NetworkPreferences(location)
    expect(await preferences.set('system')).toMatchObject({ domesticRouting: 'system' })
    expect(JSON.parse(await readFile(path.join(location, 'network-preferences.json'), 'utf8'))).toEqual({ version: 2, domesticRouting: 'system', media: DEFAULT_MEDIA_NETWORK })
    expect(await readdir(location)).toEqual(['network-preferences.json'])
    expect(new NetworkPreferences(location).domesticRouting()).toBe('system')
    await preferences.set('direct')
    expect(new NetworkPreferences(location).domesticRouting()).toBe('direct')
  })

  it('invalidates new route contexts after saving while old acquisitions keep their choice', async () => {
    const preferences = new NetworkPreferences(await directory())
    const resolve = vi.fn(async () => 'PROXY private-user:private-pass@127.0.0.1:3128')
    const policy = new NetworkPolicy(resolve, preferences.domesticRouting)
    const invalidate = vi.spyOn(policy, 'invalidate')
    preferences.attach(policy)
    const previous = policy.context('douyu')
    expect(await previous.route('https://www.douyu.com/')).toEqual({ kind: 'direct' })
    const state = await preferences.set('system')
    expect(state).toEqual({ domesticRouting: 'system', media: DEFAULT_MEDIA_NETWORK, systemProxy: { type: 'HTTP' } })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(await policy.context('douyu').route('https://www.douyu.com/')).toMatchObject({ kind: 'http' })
    expect(await previous.route('https://www.douyu.com/')).toEqual({ kind: 'direct' })
    expect(JSON.stringify(state)).not.toMatch(/private-user|private-pass|127\.0\.0\.1|3128/)
  })

  it.each(['{broken', 'null', '[]', '{"domesticRouting":"system"}', '{"version":2,"domesticRouting":"system"}',
    '{"version":1,"domesticRouting":"unknown"}', '{"version":1,"domesticRouting":"system","extra":1}', 'x'.repeat(4097)])(
    'rejects malformed, unsupported or oversized saved input', async text => {
      const location = await directory()
      await writeFile(path.join(location, 'network-preferences.json'), text)
      expect(new NetworkPreferences(location).domesticRouting()).toBe('direct')
    })

  it('rejects invalid runtime values without changing memory or disk', async () => {
    const location = await directory(), preferences = new NetworkPreferences(location)
    await expect(preferences.set('all-proxy' as never)).rejects.toThrow('Invalid domestic routing')
    expect(preferences.domesticRouting()).toBe('direct')
    expect(await readdir(location)).toEqual([])
  })

  it('serializes concurrent writes and preserves the last requested value', async () => {
    const location = await directory(), preferences = new NetworkPreferences(location)
    await Promise.all([preferences.set('system'), preferences.set('direct'), preferences.set('system')])
    expect(preferences.domesticRouting()).toBe('system')
    expect(new NetworkPreferences(location).domesticRouting()).toBe('system')
    expect(await readdir(location)).toEqual(['network-preferences.json'])
  })

  it('retains the previous in-memory mode if the atomic destination cannot be replaced', async () => {
    const location = await directory(), preferences = new NetworkPreferences(location)
    await mkdir(path.join(location, 'network-preferences.json'))
    await expect(preferences.set('system')).rejects.toThrow()
    expect(preferences.domesticRouting()).toBe('direct')
  })
})
