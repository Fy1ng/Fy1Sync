import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CookieStore } from './cookies'
import { containedPath, privateDirectory } from './privateStorage'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-storage-test-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('writes and reloads cookie data without a permission object', async () => {
  const store = new CookieStore(root)
  store.write('douyu', [
    { domain: '.douyu.com', name: 'acf_auth', value: 'synthetic', session: true },
    { domain: '.douyu.com', name: 'acf_uid', value: '1001', session: true },
  ])
  const reloaded = new CookieStore(root)
  expect(await reloaded.cookieHeader('douyu')).toBe('acf_auth=synthetic; acf_uid=1001')
  expect((await reloaded.status()).douyu.loggedIn).toBe(true)
})

it('creates nested app directories and reuses existing directories', () => {
  const target = path.join(root, 'accounts', 'local', 'profile')
  expect(privateDirectory(root, target)).toBe(target)
  expect(fs.statSync(target).isDirectory()).toBe(true)
  expect(privateDirectory(root, target)).toBe(target)
})

it.each(['..', '../outside', '.'])('rejects a path outside or equal to the app root: %s', relative => {
  expect(() => containedPath(root, path.resolve(root, relative))).toThrow('账号数据路径无效.')
})

it('rejects a directory symlink even when its destination remains inside the app root', () => {
  const target = path.join(root, 'original')
  fs.mkdirSync(target)
  const link = path.join(root, 'linked')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => containedPath(root, path.join(link, 'cookies.txt'))).toThrow('账号数据路径无效.')
  expect(() => privateDirectory(root, link)).toThrow('账号数据路径无效.')
})

it('rejects a regular file as a directory component', () => {
  const file = path.join(root, 'file')
  fs.writeFileSync(file, '')
  expect(() => privateDirectory(root, file)).toThrow('账号数据路径无效.')
})
