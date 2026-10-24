import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DouyuAccountManager } from './douyuAccounts'
import type { LoginStatus } from './login'

const roots: string[] = []
const managers: DouyuAccountManager[] = []
const a = '11111111-1111-4111-8111-111111111111'
const b = '22222222-2222-4222-8222-222222222222'
const permissions = { protect: vi.fn(), verify: vi.fn() }
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-syncer-accounts-test-'))
  roots.push(root)
  return root
}
function fakeLogin(loggedIn = false) {
  const empty = { cookieCount: 0, authKeysPresent: [] as string[], loggedIn: false, expiresAt: null, hasSessionCookies: false }
  const status: LoginStatus = { youtube: { ...empty }, douyu: { ...empty, loggedIn } }
  return {
    login: vi.fn(async () => { status.douyu = { ...empty, cookieCount: 1, loggedIn: true, authKeysPresent: ['acf_uid'] }; return { cookieCount: 1, authKeysPresent: ['acf_uid'] } }),
    loginStatus: vi.fn(async () => structuredClone(status)),
    logout: vi.fn(async () => { status.douyu = { ...empty } }),
    cookieHeader: vi.fn(async (_platform: 'douyu', _url?: string) => 'synthetic=value'),
    dispose: vi.fn(async () => {}),
  }
}
function fixture(initial?: unknown) {
  let stored = initial
  const defaultLogin = fakeLogin(true)
  const created = new Map<string, ReturnType<typeof fakeLogin>>()
  const root = tempRoot()
  const ids = [a, b]
  const store = { load: () => structuredClone(stored), save: vi.fn((value: unknown) => { stored = structuredClone(value) }) }
  const options = {
    defaultLogin, permissions, store, now: () => 100, id: () => ids.shift()!,
    createLogin: (directory: string) => { const login = fakeLogin(); created.set(directory, login); return login },
  }
  const manager = new DouyuAccountManager(root, options)
  managers.push(manager)
  return { manager, defaultLogin, created, root, store, options, stored: () => structuredClone(stored) }
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('stream-syncer-accounts-test-')) throw new Error('Unexpected test directory')
    fs.rmSync(root, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

describe('Douyu account isolation', () => {
  it('opens a canonical room only in the active account profile and invalidates pending work', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    const events: string[] = []
    f.manager.subscribe(event => { if (event.type === 'invalidated') events.push(event.accountId) })
    await expect(f.manager.openRoom(a, '9999')).rejects.toMatchObject({ code: 'no-active-account' })
    await expect(f.manager.openRoom('default', '9999?other=1')).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(f.defaultLogin.login).not.toHaveBeenCalled()
    await f.manager.openRoom('default', '9999')
    expect(f.defaultLogin.login).toHaveBeenCalledExactlyOnceWith('douyu', 'room:9999')
    expect(events).toEqual(['default', 'default'])
    expect([...f.created.values()][0]!.login).not.toHaveBeenCalled()
  })

  it('reuses the existing Douyu login in place without initializing or copying credentials', async () => {
    const f = fixture()
    expect(await f.manager.snapshot()).toMatchObject({ activeAccountId: 'default', accounts: [{ id: 'default', active: true, login: { loggedIn: true } }] })
    expect(f.created.size).toBe(0)
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.defaultLogin.login).not.toHaveBeenCalled()
  })

  it('uses distinct private roots, activates one account and never copies the old login', async () => {
    const f = fixture()
    await f.manager.add('赛事账号')
    await f.manager.add('备用账号')
    expect([...f.created.keys()]).toEqual([path.join(f.root, 'douyu', 'account-data', a), path.join(f.root, 'douyu', 'account-data', b)])
    expect((await f.manager.activate(a)).accounts.filter(account => account.active).map(account => account.id)).toEqual([a])
    expect(await f.manager.activeLoginStatus()).toMatchObject({ loggedIn: false })
    await f.manager.login(a)
    expect(await f.manager.activeLoginStatus()).toMatchObject({ loggedIn: true })
    expect(f.defaultLogin.login).not.toHaveBeenCalled()
    expect([...f.created.values()][1]!.login).not.toHaveBeenCalled()
    expect(f.stored()).not.toHaveProperty('cookies')
  })

  it('opens Yuba through each existing account manager without changing the active account', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    const login = f.created.get(path.join(f.root, 'douyu', 'account-data', a))!
    await f.manager.login(a)
    expect(await f.manager.loginYuba(a)).toMatchObject({ activeAccountId: 'default', accounts: [
      { id: 'default', active: true }, { id: a, active: false, login: { loggedIn: true } },
    ] })
    expect(login.login).toHaveBeenNthCalledWith(1, 'douyu')
    expect(login.login).toHaveBeenNthCalledWith(2, 'douyu', 'yuba')
    expect(f.created.size).toBe(1)
    expect(f.defaultLogin.login).not.toHaveBeenCalled()
    await f.manager.loginYuba('default')
    expect(f.defaultLogin.login).toHaveBeenCalledWith('douyu', 'yuba')
    expect(f.created.size).toBe(1)
  })

  it('invalidates the old account on activation and before replacing login information', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    const events: unknown[] = []
    f.manager.subscribe(event => events.push(event))
    await f.manager.activate(a)
    expect(events).toContainEqual({ type: 'invalidated', accountId: 'default' })
    events.length = 0
    const login = f.created.values().next().value!
    login.login.mockImplementation(async () => {
      expect(events).toContainEqual({ type: 'invalidated', accountId: a })
      return { cookieCount: 1, authKeysPresent: ['acf_uid'] }
    })
    await f.manager.login(a)
  })

  it('rejects a stale credential read after switching accounts', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    let finish!: (header: string) => void
    f.defaultLogin.cookieHeader.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = f.manager.cookieHeader('default', 'https://www.douyu.com/')
    await f.manager.activate(a)
    finish('synthetic=old')
    await expect(pending).rejects.toMatchObject({ code: 'no-active-account' })
    await expect(f.manager.cookieHeader('default')).rejects.toMatchObject({ code: 'no-active-account' })
  })

  it('keeps Yuba login exclusive and rejects credentials read before its revision changes', async () => {
    const f = fixture()
    let finishRead!: (header: string) => void
    f.defaultLogin.cookieHeader.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const staleRead = f.manager.cookieHeader('default', 'https://yuba.douyu.com/')
    const rejectedRead = expect(staleRead).rejects.toMatchObject({ code: 'no-active-account' })
    const events: unknown[] = []
    f.manager.subscribe(event => events.push(event))
    let finishLogin!: (result: { cookieCount: number; authKeysPresent: string[] }) => void
    f.defaultLogin.login.mockImplementationOnce(() => new Promise(resolve => { finishLogin = resolve }))
    const pending = f.manager.loginYuba('default')
    expect(f.manager.isBusy('default')).toBe(true)
    expect(events).toEqual([{ type: 'invalidated', accountId: 'default' }])
    await expect(f.manager.login('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.loginYuba('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.logout('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.remove('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.activate('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.cookieHeader('default', 'https://yuba.douyu.com/')).rejects.toMatchObject({ code: 'no-active-account' })
    finishLogin({ cookieCount: 1, authKeysPresent: ['acf_uid'] })
    await pending
    expect(f.manager.isBusy('default')).toBe(false)
    expect(events).toEqual([
      { type: 'invalidated', accountId: 'default' }, { type: 'invalidated', accountId: 'default' }, { type: 'changed' },
    ])
    finishRead('synthetic=old')
    await rejectedRead
    expect(await f.manager.cookieHeader('default', 'https://yuba.douyu.com/')).toBe('synthetic=value')
    expect(f.defaultLogin.cookieHeader).toHaveBeenLastCalledWith('douyu', 'https://yuba.douyu.com/')
  })

  it('invalidates credentials and releases the account after Yuba login failure', async () => {
    const f = fixture()
    const events: unknown[] = []
    f.manager.subscribe(event => events.push(event))
    f.defaultLogin.login.mockRejectedValueOnce(new Error('synthetic-private-browser-detail'))
    await expect(f.manager.loginYuba('default')).rejects.toMatchObject({ code: 'login-failed' })
    expect(f.manager.isBusy('default')).toBe(false)
    expect(events).toEqual([
      { type: 'invalidated', accountId: 'default' }, { type: 'invalidated', accountId: 'default' }, { type: 'changed' },
    ])
    await f.manager.login('default')
    expect(f.defaultLogin.login).toHaveBeenLastCalledWith('douyu')
  })

  it('keeps removal exclusive until logout and registry replacement finish', async () => {
    const f = fixture()
    let finish!: () => void
    f.defaultLogin.logout.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = f.manager.remove('default')
    await expect(f.manager.login('default')).rejects.toMatchObject({ code: 'account-busy' })
    await expect(f.manager.loginYuba('default')).rejects.toMatchObject({ code: 'account-busy' })
    finish()
    expect(await pending).toEqual({ activeAccountId: null, accounts: [] })
    expect(f.defaultLogin.logout).toHaveBeenCalledWith('douyu')
    expect(f.defaultLogin.dispose).not.toHaveBeenCalled()
    const restored = new DouyuAccountManager(f.root, f.options)
    managers.push(restored)
    expect(await restored.snapshot()).toEqual({ activeAccountId: null, accounts: [] })
    expect(await restored.activeCookieHeader()).toBe('')
  })

  it('removes only the selected account and leaves the current account intact', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    const removed = [...f.created.values()][0]!
    expect(await f.manager.remove(a)).toMatchObject({ activeAccountId: 'default', accounts: [{ id: 'default' }] })
    expect(removed.logout).toHaveBeenCalledWith('douyu')
    expect(removed.dispose).toHaveBeenCalledOnce()
    expect(f.defaultLogin.logout).not.toHaveBeenCalled()
  })

  it('does not change active identity when saving its registry fails', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    f.store.save.mockImplementation(() => { throw new Error('synthetic-secret-path') })
    await expect(f.manager.activate(a)).rejects.toMatchObject({ code: 'storage-failed' })
    expect(f.manager.activeAccountId).toBe('default')
  })

  it.each([null, {}, { version: 2, accounts: [], activeAccountId: null }, { version: 1, accounts: [], activeAccountId: 'default' }])('preserves malformed stored data (%j) by refusing to load', raw => {
    const store = { load: () => raw, save: vi.fn() }
    expect(() => new DouyuAccountManager(tempRoot(), { defaultLogin: fakeLogin(), permissions, store })).toThrow('斗鱼账号配置读写失败')
    expect(store.save).not.toHaveBeenCalled()
  })

  it('validates labels and identifiers without accessing an external path', async () => {
    const f = fixture()
    for (const label of ['', ' '.repeat(3), 'x'.repeat(41), 'bad\nname']) {
      await expect(f.manager.add(label)).rejects.toMatchObject({ code: 'invalid-arguments' })
    }
    await expect(f.manager.login('../outside')).rejects.toMatchObject({ code: 'account-not-found' })
    await expect(f.manager.loginYuba('../outside')).rejects.toMatchObject({ code: 'account-not-found' })
    expect(f.created.size).toBe(0)
  })

  it('disposes only owned profiles and rejects new operations afterwards', async () => {
    const f = fixture()
    await f.manager.add('第二个')
    await f.manager.dispose()
    expect([...f.created.values()][0]!.dispose).toHaveBeenCalledOnce()
    expect(f.defaultLogin.dispose).not.toHaveBeenCalled()
    await expect(f.manager.add('新的')).rejects.toMatchObject({ code: 'disposed' })
    await expect(f.manager.loginYuba(a)).rejects.toMatchObject({ code: 'disposed' })
  })
})
