import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NetworkPolicy } from '../server/networkPolicy'
import { NetworkPreferences } from './networkPreferences'

const root = path.resolve('.runtime-cache/codex-network-impl-20261030-implementation')
async function directory() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, 'network-preferences-')) }

describe('persistent domestic network preferences', () => {
  it('defaults to domestic direct without touching disk', async () => {
    const location = await directory()
    expect(await new NetworkPreferences(location).get()).toEqual({ domesticRouting: 'direct', systemProxy: { type: 'direct' } })
    expect(await readdir(location)).toEqual([])
  })

  it('persists the chosen mode atomically and reloads it after restart', async () => {
    const location = await directory()
    const preferences = new NetworkPreferences(location)
    expect(await preferences.set('system')).toMatchObject({ domesticRouting: 'system' })
    expect(JSON.parse(await readFile(path.join(location, 'network-preferences.json'), 'utf8'))).toEqual({ version: 1, domesticRouting: 'system' })
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
    expect(state).toEqual({ domesticRouting: 'system', systemProxy: { type: 'HTTP' } })
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
