import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CookieStore } from './cookies'
import { NativePrivatePermissions, type PrivatePermissionTarget } from './privateStorage'

let root: string

beforeEach(() => {
  const runtime = path.join(process.cwd(), '.runtime-cache')
  fs.mkdirSync(runtime, { recursive: true })
  root = fs.mkdtempSync(path.join(runtime, 'cookie-tests-native-'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('checks native private ACLs asynchronously and rechecks broadened ACLs when the ten minute window ends', async () => {
  let now = 1_000_000
  const permissions = new NativePrivatePermissions(() => now)
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
  // ACL-only changes can stay visible through the documented ten minute window.
  await expect(store.cookieHeader('douyu')).resolves.toBe('acf_auth=synthetic-native-check')
  now += 600_000
  await expect(store.cookieHeader('douyu')).rejects.toThrow('账号数据读写失败, 未返回任何 cookie 数据.')
  expect(() => permissions.verify(file, false)).toThrow()
}, 15_000)

class TestPermissions extends NativePrivatePermissions {
  readonly check = vi.fn<(targets: readonly PrivatePermissionTarget[]) => Promise<void>>(async () => {})
  protected override async verifyManyUncachedAsync(targets: readonly PrivatePermissionTarget[]): Promise<void> { await this.check(targets) }
}

function fixture() {
  const file = path.join(root, 'fixture.txt')
  fs.writeFileSync(file, 'synthetic')
  let now = 1_000_000
  const permissions = new TestPermissions(() => now)
  const targets = [{ target: root, directory: true }, { target: file, directory: false }]
  return { file, permissions, targets, advance: (ms: number) => { now += ms } }
}

it('caches successful file and directory checks without sliding the ten minute deadline', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  f.advance(599_999)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(1)
  f.advance(1)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it('rechecks a file when size or mtime changes and only checks cache misses', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  fs.appendFileSync(f.file, '-updated')
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenLastCalledWith([f.targets[1]])
  const stat = fs.statSync(f.file)
  fs.utimesSync(f.file, stat.atime, new Date(stat.mtimeMs + 1000))
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(3)
})

it('rechecks a replaced inode even when size and mtime are preserved', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync([f.targets[1]!])
  const before = fs.statSync(f.file)
  const replacement = path.join(root, 'replacement')
  fs.writeFileSync(replacement, 'synthetic')
  fs.utimesSync(replacement, before.atime, before.mtime)
  fs.renameSync(replacement, f.file)
  expect(fs.statSync(f.file).ino).not.toBe(before.ino)
  await f.permissions.verifyManyAsync([f.targets[1]!])
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it('never caches failures and masks verifier errors', async () => {
  const f = fixture()
  f.permissions.check.mockRejectedValueOnce(new Error('synthetic private detail'))
  await expect(f.permissions.verifyManyAsync(f.targets)).rejects.toThrow('无法验证账号数据的私有文件权限.')
  await f.permissions.verifyManyAsync(f.targets)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it('explicit invalidation evicts only the selected path', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  f.permissions.invalidate(f.file)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenLastCalledWith([f.targets[1]])
})

it('does not cache recursive checks by the root directory fingerprint', async () => {
  const f = fixture()
  const targets = [{ target: root, directory: true, recursive: true }]
  await f.permissions.verifyManyAsync(targets)
  await f.permissions.verifyManyAsync(targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it('does not resurrect a successful result invalidated while checking', async () => {
  const f = fixture()
  let release!: () => void
  f.permissions.check.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
  const pending = f.permissions.verifyManyAsync(f.targets)
  const rejected = expect(pending).rejects.toThrow('无法验证账号数据的私有文件权限.')
  f.permissions.invalidate(f.file)
  release()
  await rejected
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it.each(['invalidated', 'changed', 'failed'] as const)(
  'does not cancel a fresh permission check when an older check is %s', async cause => {
    const f = fixture()
    let releaseOld!: () => void
    let releaseCurrent!: () => void
    f.permissions.check.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { releaseOld = resolve })
      if (cause === 'failed') throw new Error('synthetic permission failure')
    }).mockImplementationOnce(async () => new Promise<void>(resolve => { releaseCurrent = resolve }))
    const stale = f.permissions.verifyManyAsync(f.targets)
    const rejected = expect(stale).rejects.toThrow('无法验证账号数据的私有文件权限.')
    if (cause === 'invalidated') f.permissions.invalidate(f.file)
    if (cause === 'changed') fs.appendFileSync(f.file, '-updated')
    const current = f.permissions.verifyManyAsync(f.targets).then(() => true, () => false)
    releaseOld()
    await rejected
    releaseCurrent()
    expect(await current).toBe(true)
    await f.permissions.verifyManyAsync(f.targets)
    expect(f.permissions.check).toHaveBeenCalledTimes(2)
  },
)

it('allows unrelated permission invalidation while another path is being checked', async () => {
  const f = fixture()
  let release!: () => void
  f.permissions.check.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
  const pending = f.permissions.verifyManyAsync(f.targets)
  f.permissions.invalidate(path.join(root, 'unrelated.json'))
  release()
  await pending
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(1)
})

it('invalidates cached descendants when recursive permissions are changed', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  f.permissions.invalidate(root, true)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenLastCalledWith(f.targets)
})

it('rejects a file changed while the asynchronous check is running and rechecks next time', async () => {
  const f = fixture()
  f.permissions.check.mockImplementationOnce(async () => { fs.appendFileSync(f.file, '-changed') })
  await expect(f.permissions.verifyManyAsync(f.targets)).rejects.toThrow('无法验证账号数据的私有文件权限.')
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})

it('still checks regular path boundaries on cache hits', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  fs.unlinkSync(f.file)
  fs.mkdirSync(f.file)
  await expect(f.permissions.verifyManyAsync(f.targets)).rejects.toThrow('无法验证账号数据的私有文件权限.')
  expect(f.permissions.check).toHaveBeenCalledTimes(1)
})

it('rechecks if the cache clock moves backwards', async () => {
  const f = fixture()
  await f.permissions.verifyManyAsync(f.targets)
  f.advance(-1)
  await f.permissions.verifyManyAsync(f.targets)
  expect(f.permissions.check).toHaveBeenCalledTimes(2)
})
