import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieStore, cookieDomainAllowed } from './cookies'
import { messageCredentials } from '../server/douyu/messageProtocol'
import type { BrowserCookie } from './cookies'
import { containedPath, powershellEnvironment, privateDirectory } from './privateStorage'

let root: string
const now = 2_000_000_000
const cookie = (overrides: Partial<BrowserCookie> = {}): BrowserCookie => ({
  domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'test-private-value', secure: true,
  expirationDate: now + 60, ...overrides,
})
const store = () => new CookieStore(root, { now: () => now })

beforeEach(() => {
  const runtime = os.tmpdir()
  fs.mkdirSync(runtime, { recursive: true })
  root = fs.mkdtempSync(path.join(runtime, 'cookie-tests-'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })


function pauseOpen(): () => void {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => { await ready; return open(...args) })
  return () => release()
}

describe('private cookie storage', () => {
  it('round-trips HttpOnly and injects host, path, secure, expiry and session semantics in main only', async () => {
    const manager = store()
    manager.write('youtube', [
      cookie({ httpOnly: true, path: '/watch' }),
      cookie({ domain: 'www.youtube.com', hostOnly: true, name: 'SID', session: true, httpOnly: true, secure: false }),
      cookie({ domain: '.google.com', name: 'HSID', secure: true, httpOnly: false }),
    ])
    const set = vi.fn(async () => {})
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    await expect(manager.injectYoutubeCookies({ cookies: { set } })).resolves.toBeUndefined()
    expect(set.mock.calls).toEqual([
      [{ url: 'https://youtube.com/watch', domain: '.youtube.com', path: '/watch', name: 'SAPISID', value: 'test-private-value', secure: true, httpOnly: true, expirationDate: now + 60 }],
      [{ url: 'http://www.youtube.com/', path: '/', name: 'SID', value: 'test-private-value', secure: false, httpOnly: true }],
      [{ url: 'https://google.com/', domain: '.google.com', path: '/', name: 'HSID', value: 'test-private-value', secure: true, httpOnly: false, expirationDate: now + 60 }],
    ])
    expect(fs.readFileSync(path.join(root, 'cookies', 'youtube.txt'), 'utf8')).toContain('#HttpOnly_.youtube.com')
    expect(JSON.stringify(await manager.status())).not.toContain('test-private-value')
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('rejects anonymous session injection and masks Electron cookie errors', async () => {
    const manager = store(), set = vi.fn(async () => { throw new Error('secret-cookie-value') })
    await expect(manager.injectYoutubeCookies({ cookies: { set } })).rejects.toThrow('未返回任何 cookie 数据')
    expect(set).not.toHaveBeenCalled()
    manager.write('youtube', [cookie({ httpOnly: true })])
    await expect(manager.injectYoutubeCookies({ cookies: { set } })).rejects.toThrow('未返回任何 cookie 数据')
  })

  it('atomically writes a platform-filtered Netscape file and returns metadata only', () => {
    const result = store().write('youtube', [cookie(), cookie({ domain: '.mail.google.com', name: 'MAIL' }), cookie({ domain: '.google.com', name: 'SID' })])
    expect(result).toEqual({ cookieCount: 2, authKeysPresent: ['SAPISID', 'SID'] })
    const file = path.join(root, 'cookies', 'youtube.txt')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('# Netscape HTTP Cookie File\n')
    expect(text).not.toContain('MAIL')
    expect(fs.readdirSync(path.dirname(file))).toEqual(['youtube.txt'])
  })

  it('reports valid auth keys and earliest persistent expiry without values', async () => {
    const manager = store()
    manager.write('youtube', [cookie(), cookie({ name: 'SID', expirationDate: now + 20 }), cookie({ name: 'HSID', session: true }), cookie({ name: 'SSID', expirationDate: now - 1 })])
    expect(await manager.status()).toEqual({
      youtube: { loggedIn: true, cookieCount: 3, authKeysPresent: ['SAPISID', 'SID', 'HSID'], expiresAt: now + 20, hasSessionCookies: true },
      douyu: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false,
        canSend: false, missingCredentialFields: ['acf_uid', 'acf_did', 'dy_did', 'did', 'acf_username', 'acf_auth_wl', 'acf_dmjwt_token', 'acf_ltkid', 'acf_biz', 'acf_stk'] },
      douyin: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false },
    })
    expect(JSON.stringify(await manager.status())).not.toContain('test-private-value')
  })

  it('names a signed-in Douyu account from acf_nickname and never for an anonymous one', async () => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_nickname', value: encodeURIComponent('解说甲') })])
    expect((await manager.status()).douyu.nickname).toBeUndefined()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_uid', value: '42' }),
      cookie({ domain: '.douyu.com', name: 'acf_nickname', value: encodeURIComponent('解说甲') })])
    expect((await manager.status()).douyu).toMatchObject({ loggedIn: true, nickname: '解说甲' })
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_uid', value: '42' }), cookie({ domain: '.douyu.com', name: 'acf_nickname', value: '%E0%A4%A' })])
    expect((await manager.status()).douyu.nickname).toBeUndefined()
  })

  it('does not call anonymous cookies a login', async () => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'dy_did' })])
    expect((await manager.status()).douyu).toMatchObject({ loggedIn: false, cookieCount: 1, authKeysPresent: [] })
  })
  it.each([false, true])('selects www credentials before parent-domain duplicates, independent of file order %s', async reverse => {
    const manager = store()
    const values = { acf_uid: '42', dy_did: '1'.repeat(32), acf_username: 'fixture-name', acf_auth_wl: 'fixture-auth' }
    const cookies = Object.entries(values).flatMap(([name, value]) => [
      cookie({ domain: '.douyu.com', name, value: name === 'acf_uid' ? '99' : value }),
      cookie({ domain: 'www.douyu.com', hostOnly: true, name, value }),
    ])
    manager.write('douyu', reverse ? cookies.reverse() : cookies)
    const header = await manager.cookieHeader('douyu', 'https://www.douyu.com/')
    expect(header.split('; ')).toHaveLength(4)
    expect(messageCredentials(header)).toMatchObject({ uid: '42', did: '1'.repeat(32) })
    expect((await manager.status()).douyu).toMatchObject({ loggedIn: true, canSend: true, missingCredentialFields: [] })
    expect(JSON.stringify(await manager.status())).not.toContain('fixture-auth')
  })

  it.each(['\nsecret', '\tsecret', '\0secret', 'a;b', 'a b'])('rejects unsafe cookie fields with a fixed error', value => {
    expect(() => store().write('youtube', [cookie({ value })])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(fs.existsSync(path.join(root, 'cookies', 'youtube.txt'))).toBe(false)
  })

  it('keeps the previous cookie file if synchronizing a replacement fails', () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    const previous = fs.readFileSync(path.join(root, 'cookies', 'youtube.txt'), 'utf8')
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('secret must not escape') })
    expect(() => manager.write('youtube', [cookie({ value: 'replacement' })])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(fs.readFileSync(path.join(root, 'cookies', 'youtube.txt'), 'utf8')).toBe(previous)
    expect(fs.readdirSync(path.join(root, 'cookies'))).toEqual(['youtube.txt'])
  })

  it('rejects malformed stored data and masks raw filesystem/parser errors', async () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    fs.writeFileSync(path.join(root, 'cookies', 'youtube.txt'), '# Netscape HTTP Cookie File\nsecret-invalid-fields\n')
    await expect(manager.status()).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  })

  it('omits expired cookies and limits Douyu headers to matching domain/path', async () => {
    const manager = store()
    manager.write('douyu', [
      cookie({ domain: '.douyu.com', name: 'acf_auth', value: 'valid' }),
      cookie({ domain: '.douyu.com', name: 'dy_did', value: 'did' }),
      cookie({ domain: 'other.douyu.com', name: 'OTHER' }),
      cookie({ domain: '.douyu.com', name: 'WRONG_PATH', path: '/member' }),
      cookie({ domain: '.douyu.com', name: 'EXPIRED', expirationDate: now - 1 }),
    ])
    expect(await manager.cookieHeader('douyu')).toBe('acf_auth=valid; dy_did=did')
  })

  it('selects host-only, domain and path cookies for the exact official activity URL', async () => {
    const manager = store()
    manager.write('douyu', [
      cookie({ domain: '.douyu.com', name: 'ROOT', value: 'root' }),
      cookie({ domain: 'www.douyu.com', hostOnly: true, name: 'WWW', value: 'www' }),
      cookie({ domain: 'yuba.douyu.com', hostOnly: true, path: '/ybapi', name: 'YUBA', value: 'yuba' }),
      cookie({ domain: '.douyu.com', path: '/member', name: 'MEMBER', value: 'member' }),
    ])
    expect(await manager.cookieHeader('douyu', 'https://www.douyu.com/')).toBe('ROOT=root; WWW=www')
    expect(await manager.cookieHeader('douyu', 'https://yuba.douyu.com/ybapi/topic/sign')).toBe('YUBA=yuba; ROOT=root')
    expect(await manager.cookieHeader('douyu', 'https://yuba.douyu.com/ybapi-other')).toBe('ROOT=root')
  })

  it.each(['https://apiv2.douyucdn.cn/', 'https://douyu.com.evil.invalid/', 'http://www.douyu.com/', 'https://user@www.douyu.com/', 'https://www.douyu.com:8443/'])('never exports a cookie header to %s', async url => {
    await expect(store().cookieHeader('douyu', url)).rejects.toThrow('账号数据读写失败')
  })

  it('uses a distinct private temp copy and deletes it when the consumer succeeds', async () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    let temporary = ''
    expect(await manager.withTemporaryCookies('youtube', async file => {
      temporary = file!
      expect(file).not.toBe(path.join(root, 'cookies', 'youtube.txt'))
      expect(fs.readFileSync(file!, 'utf8')).toContain('test-private-value')
      return 'resolved'
    })).toBe('resolved')
    expect(fs.existsSync(path.dirname(temporary))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies', 'youtube.txt'))).toBe(true)
  })

  it('deletes the temp copy when the consumer fails', async () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    let temporary = ''
    await expect(manager.withTemporaryCookies('youtube', async file => { temporary = file!; throw new Error('consumer failed') })).rejects.toThrow('consumer failed')
    expect(fs.existsSync(path.dirname(temporary))).toBe(false)
  })

  it('does not create or pass a cookie file for anonymous extraction', async () => {
    expect(await store().withTemporaryCookies('youtube', async file => file)).toBeUndefined()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('logs no cookie values, paths or authentication diagnostics', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'debug')]
    const manager = store()
    manager.write('youtube', [cookie()])
    await manager.status()
    await manager.withTemporaryCookies('youtube', async () => {})
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('logout deletes only the selected platform profile and cookies', async () => {
    const manager = store()
    manager.prepareProfile('youtube')
    manager.prepareProfile('douyu')
    manager.write('youtube', [cookie()])
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth' })])
    manager.logout('youtube')
    expect(fs.existsSync(path.join(root, 'browser-profile', 'youtube'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies', 'youtube.txt'))).toBe(false)
    expect((await manager.status()).douyu.loggedIn).toBe(true)
  })

  it('rejects a regular cookie file replaced while opening the file is pending', async () => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth', value: 'old' })])
    const release = pauseOpen()
    const pending = manager.cookieHeader('douyu')
    const rejected = expect(pending).rejects.toThrow('账号数据读写失败')
    const file = path.join(root, 'cookies', 'douyu.txt')
    const replacement = path.join(root, 'cookies', 'replacement.txt')
    fs.writeFileSync(replacement, fs.readFileSync(file, 'utf8').replace('old', 'new'))
    fs.renameSync(replacement, file)
    release()
    await rejected
  })

  it.each(['write', 'logout'] as const)('invalidates a pending read when %s changes credentials', async action => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth', value: 'old' })])
    const release = pauseOpen()
    const pending = manager.cookieHeader('douyu')
    const rejected = expect(pending).rejects.toThrow('账号数据读写失败')
    if (action === 'write') manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth', value: 'new' })])
    else manager.logout('douyu')
    release()
    await rejected
  })

  it('refuses a directory junction installed while opening the file is pending', async () => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth' })])
    const release = pauseOpen()
    const pending = manager.cookieHeader('douyu')
    const rejected = expect(pending).rejects.toThrow('账号数据读写失败')
    const directory = path.join(root, 'cookies'), moved = path.join(root, 'original-cookies')
    fs.renameSync(directory, moved)
    fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
    release()
    await rejected
    expect(fs.existsSync(path.join(moved, 'douyu.txt'))).toBe(true)
  })
})

describe('cookie path boundary', () => {
  it.each(['../outside', '/absolute'])('rejects paths outside the configured private root: %s', suffix => {
    expect(() => containedPath(root, path.resolve(root, suffix))).toThrow()
  })
  it('rejects a junction/symlink before a cookie directory can escape the root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-tests-outside-'))
    try {
      fs.symlinkSync(outside, path.join(root, 'cookies'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => store().write('youtube', [cookie()])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
      expect(fs.readdirSync(outside)).toEqual([])
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })
  it('rejects regular files used as directory components', () => {
    fs.writeFileSync(path.join(root, 'cookies'), '')
    expect(() => privateDirectory(root, path.join(root, 'cookies'))).toThrow()
  })
  it('filters lookalike domains and unrelated Google services', () => {
    for (const host of ['youtube.com.evil', 'evilyoutube.com', 'mail.google.com', '.google.evil']) expect(cookieDomainAllowed(host, 'youtube')).toBe(false)
    for (const host of ['.youtube.com', 'accounts.google.com', '.google.com']) expect(cookieDomainAllowed(host, 'youtube')).toBe(true)
  })
  it('drops inherited PowerShell module paths without mutating the parent environment', () => {
    const environment = { PSModulePath: 'pwsh7-modules', psMODULEpath: 'also-remove', KEEP: 'unchanged' }
    expect(powershellEnvironment(environment)).toEqual({ KEEP: 'unchanged' })
    expect(environment.PSModulePath).toBe('pwsh7-modules')
  })
})
