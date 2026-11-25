import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LoginManager } from './login'
import { DouyuAccountManager } from './douyuAccounts'
import type { BrowserCookie } from './cookies'

const roots: string[] = []
const managers: { dispose(): Promise<void> }[] = []
function root() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-import-save-')); roots.push(directory); return directory }
function login(directory: string) { const value = new LoginManager(directory); managers.push(value); return value }
const douyu = (uid: string): BrowserCookie[] => [
  { domain: '.douyu.com', path: '/', name: 'acf_uid', value: uid, session: true },
  { domain: '.douyu.com', path: '/', name: 'acf_auth', value: 'synthetic-session', session: true },
]
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  for (const directory of roots.splice(0)) { if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unsafe fixture'); fs.rmSync(directory, { recursive: true, force: true }) }
})
describe('browser import persistence through existing account ownership', () => {
  it('persists verified names and avatars with cookies and restores them after restart', async () => {
    const directory = root(); const manager = login(directory)
    const identity = { uid: '42', username: '导入账号', avatar: 'data:image/png;base64,AQ==' }
    await manager.importCookies('douyu', douyu('42'), identity)
    expect((await manager.loginStatus()).douyu).toMatchObject({ loggedIn: true, nickname: '导入账号', avatar: identity.avatar })
    expect(await manager.savedUserId('douyu')).toBe('42')
    const restored = login(directory)
    expect((await restored.loginStatus()).douyu).toMatchObject({ nickname: '导入账号', avatar: identity.avatar })
    await manager.logout('douyu')
    expect((await manager.loginStatus()).douyu).not.toHaveProperty('nickname')
  })
  it('preserves the original file when import is cancelled or metadata cannot be saved', async () => {
    const directory = root(); const manager = login(directory)
    await manager.importCookies('douyu', douyu('42'), { uid: '42', username: '原账号' })
    const file = path.join(directory, 'cookies/douyu.txt'); const before = fs.readFileSync(file)
    const controller = new AbortController(); controller.abort()
    await expect(manager.importCookies('douyu', douyu('84'), { username: '新账号' }, controller.signal)).rejects.toMatchObject({ code: 'login-cancelled' })
    await expect(manager.importCookies('douyu', douyu('84'), { username: '新账号', avatar: 'https://arbitrary.example/avatar' })).rejects.toMatchObject({ code: 'cookie-storage-failed' })
    expect(fs.readFileSync(file)).toEqual(before)
    expect((await manager.loginStatus()).douyu.nickname).toBe('原账号')
  })
  it('matches Douyu UIDs without duplicate accounts and preserves the active account', async () => {
    const directory = root(); const defaultLogin = login(directory)
    const accounts = new DouyuAccountManager(directory, { defaultLogin, createLogin: login }); managers.push(accounts)
    expect(await accounts.importCookies(douyu('42'), { uid: '42', username: '第一个' })).toBe('default')
    const second = await accounts.importCookies(douyu('84'), { uid: '84', username: '第二个' })
    expect(second).not.toBe('default')
    expect(await accounts.importCookies(douyu('84'), { uid: '84', username: '第二个更新' })).toBe(second)
    expect((await accounts.snapshot()).accounts).toHaveLength(2)
    expect(accounts.activeAccountId).toBe('default')
  })
  it('removes a newly allocated Douyu account on a failed import', async () => {
    const directory = root(); const defaultLogin = login(directory)
    const accounts = new DouyuAccountManager(directory, { defaultLogin, createLogin: login }); managers.push(accounts)
    await expect(accounts.importCookies(douyu('84'), { uid: '84', username: 'invalid\nname' }, { kind: 'new' })).rejects.toThrow()
    expect((await accounts.snapshot()).accounts).toHaveLength(1)
  })
  it('reuses a signed-out default slot with anonymous cookies and activates an import when no account was active', async () => {
    const directory = root(); const defaultLogin = login(directory)
    const accounts = new DouyuAccountManager(directory, { defaultLogin, createLogin: login }); managers.push(accounts)
    ;(defaultLogin as unknown as { store: { write: (platform: 'douyu', cookies: BrowserCookie[]) => void } }).store
      .write('douyu', [{ domain: '.douyu.com', path: '/', name: 'dy_did', value: '1'.repeat(32), session: true }])
    expect(await accounts.importCookies(douyu('42'), { uid: '42', username: '复用默认' })).toBe('default')
    expect(accounts.activeAccountId).toBe('default')
    await accounts.remove('default')
    expect(accounts.activeAccountId).toBeNull()
    const created = await accounts.importCookies(douyu('84'), { uid: '84', username: '新建并激活' })
    expect(accounts.activeAccountId).toBe(created)
  })
  it('activates a newly imported Douyu account when the default slot is signed out', async () => {
    const directory = root(); const defaultLogin = login(directory)
    const accounts = new DouyuAccountManager(directory, { defaultLogin, createLogin: login }); managers.push(accounts)
    await accounts.importCookies(douyu('42'), { uid: '42', username: '已退出旧号' })
    await accounts.logout('default')
    expect((await accounts.activeLoginStatus()).loggedIn).toBe(false)
    const importedNew = await accounts.importCookies(douyu('84'), { uid: '84', username: '新导入号' }, { kind: 'new' })
    expect(importedNew).not.toBe('default')
    expect(accounts.activeAccountId).toBe(importedNew)
    expect((await accounts.activeLoginStatus()).loggedIn).toBe(true)
  })
})
