import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieStore, cookieDomainAllowed } from './cookies'
import type { BrowserCookie } from './cookies'
import { containedPath, powershellEnvironment, PRIVATE_ACL_SCRIPT, privateDirectory } from './privateStorage'
import type { PrivatePermissions } from './privateStorage'

let root: string
let permissions: PrivatePermissions
const now = 2_000_000_000
const cookie = (overrides: Partial<BrowserCookie> = {}): BrowserCookie => ({
  domain: '.youtube.com', path: '/', name: 'SAPISID', value: 'test-private-value', secure: true,
  expirationDate: now + 60, ...overrides,
})
const store = () => new CookieStore(root, { permissions, now: () => now })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.cookie-tests-'))
  permissions = { protect: vi.fn(), verify: vi.fn() }
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('private cookie storage', () => {
  it('atomically writes a platform-filtered Netscape file and returns metadata only', () => {
    const result = store().write('youtube', [cookie(), cookie({ domain: '.mail.google.com', name: 'MAIL' }), cookie({ domain: '.google.com', name: 'SID' })])
    expect(result).toEqual({ cookieCount: 2, authKeysPresent: ['SAPISID', 'SID'] })
    const file = path.join(root, 'cookies', 'youtube.txt')
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('# Netscape HTTP Cookie File\n')
    expect(text).not.toContain('MAIL')
    expect(permissions.protect).toHaveBeenCalledWith(expect.stringMatching(/\.youtube-.+\.tmp$/), false)
    expect(permissions.verify).toHaveBeenCalledWith(file, false)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['youtube.txt'])
  })

  it('reports valid auth keys and earliest persistent expiry without values', () => {
    const manager = store()
    manager.write('youtube', [cookie(), cookie({ name: 'SID', expirationDate: now + 20 }), cookie({ name: 'HSID', session: true }), cookie({ name: 'SSID', expirationDate: now - 1 })])
    expect(manager.status()).toEqual({
      youtube: { loggedIn: true, cookieCount: 3, authKeysPresent: ['SAPISID', 'SID', 'HSID'], expiresAt: now + 20, hasSessionCookies: true },
      douyu: { loggedIn: false, cookieCount: 0, authKeysPresent: [], expiresAt: null, hasSessionCookies: false },
    })
    expect(JSON.stringify(manager.status())).not.toContain('test-private-value')
  })

  it('does not call anonymous cookies a login', () => {
    const manager = store()
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'dy_did' })])
    expect(manager.status().douyu).toMatchObject({ loggedIn: false, cookieCount: 1, authKeysPresent: [] })
  })

  it.each(['\nsecret', '\tsecret', '\0secret', 'a;b', 'a b'])('rejects unsafe cookie fields with a fixed error', value => {
    expect(() => store().write('youtube', [cookie({ value })])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(fs.existsSync(path.join(root, 'cookies', 'youtube.txt'))).toBe(false)
  })

  it('keeps the previous cookie file if private permission protection fails', () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    const previous = fs.readFileSync(path.join(root, 'cookies', 'youtube.txt'), 'utf8')
    vi.mocked(permissions.protect).mockImplementation((file, directory) => { if (!directory) throw new Error('secret must not escape: ' + file) })
    expect(() => manager.write('youtube', [cookie({ value: 'replacement' })])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
    expect(fs.readFileSync(path.join(root, 'cookies', 'youtube.txt'), 'utf8')).toBe(previous)
    expect(fs.readdirSync(path.join(root, 'cookies'))).toEqual(['youtube.txt'])
  })

  it('rejects malformed stored data and masks raw filesystem/parser errors', () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    fs.writeFileSync(path.join(root, 'cookies', 'youtube.txt'), '# Netscape HTTP Cookie File\nsecret-invalid-fields\n')
    expect(() => manager.status()).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  })

  it('omits expired cookies and limits Douyu headers to matching domain/path', () => {
    const manager = store()
    manager.write('douyu', [
      cookie({ domain: '.douyu.com', name: 'acf_auth', value: 'valid' }),
      cookie({ domain: '.douyu.com', name: 'dy_did', value: 'did' }),
      cookie({ domain: 'other.douyu.com', name: 'OTHER' }),
      cookie({ domain: '.douyu.com', name: 'WRONG_PATH', path: '/member' }),
      cookie({ domain: '.douyu.com', name: 'EXPIRED', expirationDate: now - 1 }),
    ])
    expect(manager.cookieHeader('douyu')).toBe('acf_auth=valid; dy_did=did')
  })

  it('selects host-only, domain and path cookies for the exact official activity URL', () => {
    const manager = store()
    manager.write('douyu', [
      cookie({ domain: '.douyu.com', name: 'ROOT', value: 'root' }),
      cookie({ domain: 'www.douyu.com', hostOnly: true, name: 'WWW', value: 'www' }),
      cookie({ domain: 'yuba.douyu.com', hostOnly: true, path: '/ybapi', name: 'YUBA', value: 'yuba' }),
      cookie({ domain: '.douyu.com', path: '/member', name: 'MEMBER', value: 'member' }),
    ])
    expect(manager.cookieHeader('douyu', 'https://www.douyu.com/')).toBe('ROOT=root; WWW=www')
    expect(manager.cookieHeader('douyu', 'https://yuba.douyu.com/ybapi/topic/sign')).toBe('YUBA=yuba; ROOT=root')
    expect(manager.cookieHeader('douyu', 'https://yuba.douyu.com/ybapi-other')).toBe('ROOT=root')
  })

  it.each(['https://apiv2.douyucdn.cn/', 'https://douyu.com.evil.invalid/', 'http://www.douyu.com/', 'https://user@www.douyu.com/', 'https://www.douyu.com:8443/'])('never exports a cookie header to %s', url => {
    expect(() => store().cookieHeader('douyu', url)).toThrow('账号数据读写失败')
  })

  it('uses a distinct private temp copy and deletes it when the consumer succeeds', async () => {
    const manager = store()
    manager.write('youtube', [cookie()])
    let temporary = ''
    expect(await manager.withTemporaryCookies('youtube', async file => {
      temporary = file!
      expect(file).not.toBe(path.join(root, 'cookies', 'youtube.txt'))
      expect(fs.readFileSync(file!, 'utf8')).toContain('test-private-value')
      expect(permissions.protect).toHaveBeenCalledWith(path.dirname(file!), true)
      expect(permissions.protect).toHaveBeenCalledWith(file!, false)
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
    manager.status()
    await manager.withTemporaryCookies('youtube', async () => {})
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('logout deletes only the selected platform profile and cookies', () => {
    const manager = store()
    manager.prepareProfile('youtube')
    manager.prepareProfile('douyu')
    manager.write('youtube', [cookie()])
    manager.write('douyu', [cookie({ domain: '.douyu.com', name: 'acf_auth' })])
    manager.logout('youtube')
    expect(fs.existsSync(path.join(root, 'browser-profile', 'youtube'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'cookies', 'youtube.txt'))).toBe(false)
    expect(manager.status().douyu.loggedIn).toBe(true)
  })
})

describe('cookie path and permission boundary', () => {
  it.each(['../outside', '/absolute'])('rejects paths outside the configured private root: %s', suffix => {
    expect(() => containedPath(root, path.resolve(root, suffix))).toThrow()
  })
  it('rejects a junction/symlink before a cookie directory can escape the root', () => {
    const outside = fs.mkdtempSync(path.join(process.cwd(), '.cookie-tests-outside-'))
    try {
      fs.symlinkSync(outside, path.join(root, 'cookies'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => store().write('youtube', [cookie()])).toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
      expect(fs.readdirSync(outside)).toEqual([])
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })
  it('rejects regular files used as directory components', () => {
    fs.writeFileSync(path.join(root, 'cookies'), '')
    expect(() => privateDirectory(root, path.join(root, 'cookies'), permissions)).toThrow()
  })
  it('filters lookalike domains and unrelated Google services', () => {
    for (const host of ['youtube.com.evil', 'evilyoutube.com', 'mail.google.com', '.google.evil']) expect(cookieDomainAllowed(host, 'youtube')).toBe(false)
    for (const host of ['.youtube.com', 'accounts.google.com', '.google.com']) expect(cookieDomainAllowed(host, 'youtube')).toBe(true)
  })
  it('drops inherited PowerShell module paths without mutating the parent environment', () => {
    const environment = { PSModulePath: 'pwsh7-modules', psMODULEpath: 'also-remove', KEEP: 'unchanged' }
    expect(powershellEnvironment(environment)).toEqual({ KEEP: 'unchanged' })
    expect(environment.PSModulePath).toBe('pwsh7-modules')
    expect(PRIVATE_ACL_SCRIPT).toContain("$_.AccessControlType -eq 'Allow'")
    expect(PRIVATE_ACL_SCRIPT).toContain("StartsWith('S-1-15-3-')")
    expect(PRIVATE_ACL_SCRIPT).toContain('ReparsePoint')
  })
})
