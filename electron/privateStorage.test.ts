import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CookieStore } from './cookies'
import { NativePrivatePermissions } from './privateStorage'

let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(process.cwd(), '.cookie-tests-native-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('checks native private ACLs asynchronously and still rejects permissions granted to another identity', async () => {
  const permissions = new NativePrivatePermissions()
  const store = new CookieStore(root, { permissions })
  store.write('douyu', [{ domain: '.douyu.com', path: '/', secure: true, session: true, name: 'acf_auth', value: 'synthetic-native-check' }])

  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => store.cookieHeader('douyu')))
    expect(results.every(result => result === 'acf_auth=synthetic-native-check')).toBe(true)
    if (process.platform === 'win32') expect(ticks).toBeGreaterThan(0)
  } finally { clearInterval(timer) }

  const file = path.join(root, 'cookies', 'douyu.txt')
  if (process.platform === 'win32') {
    // This disposable file contains only the synthetic value above. Granting read
    // access proves that the async path rejects the same broadened ACL as before.
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
    const changed = spawnSync(executable, [file, '/grant', '*S-1-1-0:R'], { shell: false, windowsHide: true, stdio: 'ignore' })
    expect(changed.status).toBe(0)
  } else fs.chmodSync(file, 0o644)
  await expect(store.cookieHeader('douyu')).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  expect(() => permissions.verify(file, false)).toThrow()
}, 15_000)
