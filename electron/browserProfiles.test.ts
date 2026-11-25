import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverBrowserProfiles, publicBrowserProfile } from './browserProfiles'

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-profiles-'))
  roots.push(root)
  return { root, local: path.join(root, 'local'), roaming: path.join(root, 'roaming') }
}
async function file(name: string, data = 'synthetic') { await fs.mkdir(path.dirname(name), { recursive: true }); await fs.writeFile(name, data) }
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture'); await fs.rm(root, { recursive: true, force: true }) } })
describe('browser Profile metadata discovery', () => {
  it('discovers Chromium channels and Profile names without exporting paths or browser account identifiers', async () => {
    const f = await fixture()
    const chrome = path.join(f.local, 'Google/Chrome/User Data')
    const edge = path.join(f.local, 'Microsoft/Edge Beta/User Data')
    const edgeCanary = path.join(f.local, 'Microsoft/Edge SxS/User Data')
    await file(path.join(chrome, 'Default/Network/Cookies'))
    await file(path.join(chrome, 'Profile 1/Network/Cookies'))
    await file(path.join(edge, 'Default/Network/Cookies'))
    await file(path.join(edgeCanary, 'Default/Network/Cookies'))
    await file(path.join(chrome, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 1', info_cache: {
      Default: { name: '个人', user_name: 'private@example.com' }, 'Profile 1': { name: '工作' },
    } } }))
    const found = await discoverBrowserProfiles({ platform: 'win32', localAppData: f.local, appData: f.roaming })
    expect(found).toHaveLength(4)
    expect(found[0]).toMatchObject({ name: '工作', isDefault: true, browser: 'chrome' })
    expect(found.some(profile => profile.browserName === 'Microsoft Edge Beta')).toBe(true)
    expect(found.some(profile => profile.browserName === 'Microsoft Edge Canary')).toBe(true)
    const publicData = JSON.stringify(found.map(publicBrowserProfile))
    expect(publicData).not.toContain(f.root)
    expect(publicData).not.toContain('private@example.com')
    expect(new Set(found.map(profile => profile.id)).size).toBe(4)
  })
  it('resolves Firefox registered, unregistered, and external Profiles with default flags', async () => {
    const f = await fixture()
    const firefox = path.join(f.roaming, 'Mozilla/Firefox')
    const external = path.join(f.root, 'custom-profile')
    await file(path.join(firefox, 'Profiles/registered/cookies.sqlite'))
    await file(path.join(firefox, 'Profiles/unregistered/cookies.sqlite'))
    await file(path.join(external, 'cookies.sqlite'))
    await file(path.join(firefox, 'profiles.ini'), `[Profile0]\nName=默认\nIsRelative=1\nPath=Profiles/registered\nDefault=1\n[Profile1]\nName=自定义\nIsRelative=0\nPath=${external}\n`)
    const found = await discoverBrowserProfiles({ platform: 'win32', localAppData: f.local, appData: f.roaming })
    expect(found).toHaveLength(3)
    expect(found[0]).toMatchObject({ name: '默认', isDefault: true })
    expect(found.some(profile => profile.directory === external)).toBe(true)
  })
  it('returns an empty list for absent browsers or unsupported hosts', async () => {
    const f = await fixture()
    expect(await discoverBrowserProfiles({ platform: 'win32', localAppData: f.local, appData: f.roaming })).toEqual([])
    expect(await discoverBrowserProfiles({ platform: 'linux' })).toEqual([])
  })
})
