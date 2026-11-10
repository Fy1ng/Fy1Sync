import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedYtdlp, officialDownload, parseManagedManifest, releaseChecksum } from './toolUpdater'
import { ytdlpReleaseAsset } from './toolPlatform'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, access: vi.fn(original.access), chmod: vi.fn(original.chmod), realpath: vi.fn(original.realpath) }
})

const roots: string[] = []
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(access).mockReset().mockImplementation(actual.access)
  vi.mocked(realpath).mockReset().mockImplementation(actual.realpath)
  vi.mocked(chmod).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(platform: NodeJS.Platform = 'win32', arch = 'x64') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-update-')); roots.push(root)
  const network = { version: '2026.10.21', bytes: Buffer.from('verified executable fixture'), wrongHash: false, fail: false }
  const asset = ytdlpReleaseAsset(platform, arch)!
  const options = { platform, arch }
  const transport = vi.fn(async (url: string) => {
    if (network.fail) throw new Error('private upstream URL/token/local path must stay private')
    const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${network.version}/`
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: network.version, draft: false, prerelease: false,
      assets: [{ name: asset, browser_download_url: base + asset, size: network.bytes.length }, { name: 'SHA2-256SUMS', browser_download_url: base + 'SHA2-256SUMS', size: 128 }] }))
    if (url === base + 'SHA2-256SUMS') return new Response(`${network.wrongHash ? 'a'.repeat(64) : createHash('sha256').update(network.bytes).digest('hex')}  ${asset}\n`)
    if (url === base + asset) return new Response(network.bytes)
    throw new Error('unexpected test URL')
  })
  const verify = vi.fn(async (_file: string) => network.version)
  const updater = new ManagedYtdlp(root, { transport, verify, ...options })
  return { root, network, transport, verify, updater, options, asset }
}
describe('managed yt-dlp updater', () => {
  it('accepts a canonical macOS system parent alias for updates, startup and rollback', async () => {
    const f = await fixture('darwin', 'arm64')
    const userData = path.join(f.root, 'var', 'folders', 'user-data')
    await mkdir(userData, { recursive: true })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const canonicalUserData = path.join(f.root, 'private', 'var', 'folders', 'user-data')
    vi.mocked(realpath).mockImplementation((async file => {
      const resolved = await actual.realpath(file)
      const relative = path.relative(userData, resolved)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
        ? path.join(canonicalUserData, relative) : resolved
    }) as typeof realpath)
    const updater = new ManagedYtdlp(userData, { ...f.options, transport: f.transport, verify: f.verify })
    expect(await updater.activePath()).toBeUndefined()
    expect(f.transport).not.toHaveBeenCalled()
    expect((await updater.update()).phase).toBe('ready')
    const selected = await updater.activePath()
    expect(await readFile(selected!)).toEqual(f.network.bytes)
    expect(await new ManagedYtdlp(userData, f.options).activePath()).toBe(selected)
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('next native executable')
    expect((await updater.update()).phase).toBe('ready')
    expect((await updater.restore('previous')).phase).toBe('restored')
    expect(await updater.activePath()).toBe(selected)
    expect((await updater.restore('bundled')).activeVersion).toBeUndefined()
    expect(await new ManagedYtdlp(userData, f.options).activePath()).toBeUndefined()
  })
  it.each(['managed-root', 'executable'] as const)('rejects canonical %s escape instead of treating it as a system parent alias', async target => {
    const f = await fixture('darwin', 'arm64')
    await f.updater.update()
    const selected = await f.updater.activePath()
    const root = path.join(f.root, 'managed-tools', 'yt-dlp')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(realpath).mockImplementation((async file => {
      const resolved = await actual.realpath(file)
      return resolved === (target === 'managed-root' ? root : selected) ? path.join(f.root, 'escaped', path.basename(resolved)) : resolved
    }) as typeof realpath)
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBeUndefined()
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it('rejects a userData root symlink even when its parent may have a canonical alias', async () => {
    const f = await fixture('darwin', 'arm64')
    const outside = await mkdtemp(path.join(os.tmpdir(), 'syncer-outside-')); roots.push(outside)
    const linkedRoot = path.join(f.root, 'linked-data')
    await symlink(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const updater = new ManagedYtdlp(linkedRoot, { ...f.options, transport: f.transport, verify: f.verify })
    expect(await updater.activePath()).toBeUndefined()
    expect((await updater.update()).phase).toBe('error')
    expect(await readdir(outside)).toEqual([])
    expect(f.verify).not.toHaveBeenCalled()
  })
  it('rejects a managed yt-dlp root symlink without writing through it', async () => {
    const f = await fixture('darwin', 'arm64')
    const outside = await mkdtemp(path.join(os.tmpdir(), 'syncer-outside-')); roots.push(outside)
    await mkdir(path.join(f.root, 'managed-tools'))
    await symlink(outside, path.join(f.root, 'managed-tools', 'yt-dlp'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.updater.activePath()).toBeUndefined()
    expect((await f.updater.update()).phase).toBe('error')
    expect(await readdir(outside)).toEqual([])
    expect(f.verify).not.toHaveBeenCalled()
  })
  it('rejects a version-directory symlink even when its target stays inside userData', async () => {
    const f = await fixture('darwin', 'arm64')
    await f.updater.update()
    const selected = await f.updater.activePath()
    const directory = path.dirname(selected!), moved = path.join(f.root, 'linked-version')
    await rename(directory, moved)
    await symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBeUndefined()
    expect(await readFile(path.join(moved, 'yt-dlp'))).toEqual(f.network.bytes)
  })
  it.each([
    ['darwin', 'x64', 'yt-dlp'], ['darwin', 'arm64', 'yt-dlp'],
    ['linux', 'x64', 'yt-dlp_linux'], ['linux', 'arm64', 'yt-dlp_linux_aarch64'],
    ['win32', 'arm64', 'yt-dlp_arm64.exe'], ['win32', 'ia32', 'yt-dlp_x86.exe'],
  ] as const)('downloads and restores the matching official asset for %s/%s', async (platform, arch, filename) => {
    const f = await fixture(platform, arch)
    f.verify.mockImplementation(async (file: string) => {
      expect(path.basename(file)).toBe(filename)
      if (platform !== 'win32') {
        expect(chmod).toHaveBeenCalledWith(file, 0o700)
        if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o700)
      }
      return f.network.version
    })
    expect((await f.updater.update()).phase).toBe('ready')
    const selected = await f.updater.activePath()
    expect(path.basename(selected!)).toBe(filename)
    expect(f.transport.mock.calls.map(([url]) => url)).toContain(`https://github.com/yt-dlp/yt-dlp/releases/download/${f.network.version}/${f.asset}`)
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBe(selected)
    const firstVersion = f.network.version
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('next native executable')
    expect((await f.updater.update()).phase).toBe('ready')
    expect((await f.updater.restore('previous')).activeVersion).toBe(firstVersion)
    expect(await f.updater.activePath()).toBe(selected)
  })
  it.each([['linux', 'ia32'], ['darwin', 'ia32'], ['win32', 'riscv64']] as const)('refuses unsupported %s/%s before any network request', async (platform, arch) => {
    const f = await fixture()
    const updater = new ManagedYtdlp(f.root, { platform, arch, transport: f.transport, verify: f.verify })
    expect((await updater.update()).phase).toBe('error')
    expect(await updater.activePath()).toBeUndefined()
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.verify).not.toHaveBeenCalled()
  })
  it.each([
    ['win32', 'x64', 'darwin', 'arm64'], ['darwin', 'arm64', 'win32', 'x64'], ['win32', 'x64', 'win32', 'arm64'],
  ] as const)('does not execute a managed manifest from %s/%s on %s/%s', async (platform, arch, nextPlatform, nextArch) => {
    const f = await fixture(platform, arch)
    await f.updater.update()
    expect(await new ManagedYtdlp(f.root, { platform: nextPlatform, arch: nextArch }).activePath()).toBeUndefined()
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it('never uses a Windows checksum to verify the macOS asset', async () => {
    const f = await fixture('darwin', 'arm64')
    const transport = vi.fn(async (url: string) => url.endsWith('/SHA2-256SUMS')
      ? new Response(`${createHash('sha256').update(f.network.bytes).digest('hex')}  yt-dlp.exe\n`)
      : f.transport(url))
    expect((await new ManagedYtdlp(f.root, { ...f.options, transport, verify: f.verify }).update()).phase).toBe('error')
    expect(f.verify).not.toHaveBeenCalled()
    expect(await f.updater.activePath()).toBeUndefined()
  })
  it('requires Unix execute permission when validating and restoring a macOS managed file', async () => {
    const f = await fixture('darwin', 'arm64')
    await f.updater.update()
    const previous = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('next native executable')
    await f.updater.update()
    const active = await f.updater.activePath()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(access).mockImplementation(async (file, mode) => {
      if (file === active && mode === constants.X_OK) throw new Error('permission denied')
      return actual.access(file, mode)
    })
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBe(previous)
    expect(access).toHaveBeenCalledWith(active, constants.X_OK)
    expect((await f.updater.restore('previous')).phase).toBe('restored')
    expect(await f.updater.activePath()).toBe(previous)
  })
  it('keeps the current macOS version when setting execute permission fails', async () => {
    const f = await fixture('darwin', 'x64')
    await f.updater.update()
    const selected = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('next native executable')
    vi.mocked(chmod).mockRejectedValueOnce(new Error('permission denied'))
    expect((await f.updater.update()).phase).toBe('error')
    expect(await f.updater.activePath()).toBe(selected)
    expect(f.verify).toHaveBeenCalledOnce()
    expect((await readdir(path.join(f.root, 'managed-tools', 'yt-dlp'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('rechecks the macOS executable hash after its version process has run', async () => {
    const f = await fixture('darwin', 'x64')
    f.verify.mockImplementation(async file => { await writeFile(file, 'tampered after download'); return f.network.version })
    expect((await f.updater.update()).phase).toBe('error')
    expect(await f.updater.activePath()).toBeUndefined()
    expect(await readdir(path.join(f.root, 'managed-tools', 'yt-dlp'))).toEqual([])
  })
  it('refuses to activate a macOS file whose execute permission is lost during version verification', async () => {
    const f = await fixture('darwin', 'x64')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    f.verify.mockImplementation(async executable => {
      vi.mocked(access).mockImplementation(async (file, mode) => {
        if (file === executable && mode === constants.X_OK) throw new Error('permission denied')
        return actual.access(file, mode)
      })
      return f.network.version
    })
    expect((await f.updater.update()).phase).toBe('error')
    expect(await f.updater.activePath()).toBeUndefined()
    expect(await readdir(path.join(f.root, 'managed-tools', 'yt-dlp'))).toEqual([])
  })
  it('does no startup network request and atomically activates a verified version', async () => {
    const f = await fixture()
    expect(await f.updater.activePath()).toBeUndefined()
    expect(f.transport).not.toHaveBeenCalled()
    expect((await f.updater.update()).phase).toBe('ready')
    const selected = await f.updater.activePath()
    expect(await readFile(selected!)).toEqual(f.network.bytes)
    expect(f.verify).toHaveBeenCalledOnce()
    const restarted = new ManagedYtdlp(f.root, f.options)
    expect(await restarted.activePath()).toBe(selected)
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it('refuses a managed-tools junction before creating files outside userData', async () => {
    const f = await fixture(), outside = await mkdtemp(path.join(os.tmpdir(), 'syncer-outside-')); roots.push(outside)
    await symlink(outside, path.join(f.root, 'managed-tools'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await f.updater.activePath()).toBeUndefined()
    expect((await f.updater.update()).phase).toBe('error')
    expect(await readdir(outside)).toEqual([])
  })
  it('uses one in-flight operation for concurrent clicks', async () => {
    const f = await fixture()
    const a = f.updater.update(), b = f.updater.update()
    expect(a).toBe(b)
    expect((await a).phase).toBe('ready')
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it.skipIf(process.platform !== 'win32')('keeps the old manifest and selection when atomic replacement is denied', async () => {
    const f = await fixture(); await f.updater.update()
    const selected = await f.updater.activePath(), manifest = path.join(f.root, 'managed-tools', 'yt-dlp', 'active.json')
    const before = await readFile(manifest, 'utf8')
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('second executable')
    await chmod(manifest, 0o444)
    try {
      expect((await f.updater.update()).phase).toBe('error')
      expect(await f.updater.activePath()).toBe(selected)
      expect(await readFile(manifest, 'utf8')).toBe(before)
    } finally { await chmod(manifest, 0o600) }
  })
  it('keeps the previous executable available for active processes and explicit rollback', async () => {
    const f = await fixture()
    await f.updater.update()
    const previous = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('second executable')
    const result = await f.updater.update()
    expect(result.previousVersion).toBe('2026.10.21')
    const active = await f.updater.activePath()
    expect(active).not.toBe(previous)
    expect(await readFile(previous!, 'utf8')).toBe('verified executable fixture')
    expect((await f.updater.restore('previous')).activeVersion).toBe('2026.10.21')
    expect(await f.updater.activePath()).toBe(previous)
    expect((await f.updater.restore('bundled')).activeVersion).toBeUndefined()
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBeUndefined()
  })
  it.each(['checksum', 'network', 'version'] as const)('retains the selected version after %s failure', async failure => {
    const f = await fixture(); await f.updater.update()
    const selected = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('second executable')
    if (failure === 'checksum') f.network.wrongHash = true
    if (failure === 'network') f.network.fail = true
    if (failure === 'version') f.verify.mockResolvedValue('2026.01.01')
    const result = await f.updater.update()
    expect(result.phase).toBe('error')
    expect(await f.updater.activePath()).toBe(selected)
    expect(JSON.stringify(result)).not.toMatch(/private|https|token|syncer-update/)
    expect((await readdir(path.join(f.root, 'managed-tools', 'yt-dlp'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('safely rejects oversized or corrupt startup manifests without a network request', async () => {
    const f = await fixture(); await f.updater.update()
    const manifest = path.join(f.root, 'managed-tools', 'yt-dlp', 'active.json')
    for (const text of ['not json', '{"schema":2}', 'a'.repeat(4097), '{"schema":1,"active":{"id":"../../evil.exe"}}']) {
      await writeFile(manifest, text)
      expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBeUndefined()
    }
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it('falls back to a hash-verified previous version after an active file is corrupted', async () => {
    const f = await fixture(); await f.updater.update()
    const old = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('second executable'); await f.updater.update()
    await writeFile((await f.updater.activePath())!, 'damaged')
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBe(old)
    await writeFile(old!, 'also damaged')
    expect(await new ManagedYtdlp(f.root, f.options).activePath()).toBeUndefined()
  })
  it('never downgrades a newer managed version or downloads an already bundled stable version', async () => {
    const f = await fixture()
    const updater = new ManagedYtdlp(f.root, { transport: f.transport, verify: f.verify, baselineVersion: '2026.10.21', ...f.options })
    expect((await updater.update()).phase).toBe('current')
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.verify).not.toHaveBeenCalled()
  })
  it.each([true, false])('rejects a duplicate asset or non-official asset URL (%s)', async duplicate => {
    const f = await fixture()
    const transport = vi.fn(async () => new Response(JSON.stringify({ tag_name: '2026.10.22', draft: false, prerelease: false, assets: [
      { name: 'yt-dlp.exe', browser_download_url: duplicate ? 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.22/yt-dlp.exe' : 'https://evil.invalid/yt-dlp.exe', size: 4 },
      ...(duplicate ? [{ name: 'yt-dlp.exe', size: 4 }] : []),
    ] })))
    expect((await new ManagedYtdlp(f.root, { transport, verify: f.verify, ...f.options }).update()).phase).toBe('error')
    expect(f.verify).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledOnce()
  })
})
describe('official bounded downloads', () => {
  it.each(['http://github.com/a', 'https://github.com.evil.invalid/a', 'https://evil@github.com/a', 'https://github.com:444/a'])('rejects untrusted destination %s before transport', async url => {
    const transport = vi.fn()
    await expect(officialDownload(url, 10, async () => {}, transport)).rejects.toMatchObject({ code: 'network' })
    expect(transport).not.toHaveBeenCalled()
  })
  it('rejects an off-allowlist redirect and excessive redirects', async () => {
    const external = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/file' } }))
    await expect(officialDownload('https://github.com/file', 10, async () => {}, external)).rejects.toMatchObject({ code: 'network' })
    expect(external).toHaveBeenCalledOnce()
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/file' } }))
    await expect(officialDownload('https://github.com/file', 10, async () => {}, loop)).rejects.toMatchObject({ code: 'network' })
    expect(loop).toHaveBeenCalledTimes(5)
  })
  it.each([true, false])('bounds declared and streamed bytes (%s)', async declared => {
    await expect(officialDownload('https://github.com/file', 4, async () => {}, async () => new Response('too long', { headers: declared ? { 'content-length': '8' } : {} }))).rejects.toMatchObject({ code: 'limit' })
  })
  it('rejects unexpected compression instead of trusting compressed lengths', async () => {
    await expect(officialDownload('https://github.com/file', 20, async () => {}, async () => new Response('decoded', { headers: { 'content-encoding': 'gzip', 'content-length': '5' } }))).rejects.toMatchObject({ code: 'network' })
  })
  it('cancels a stalled body at the operation deadline', async () => {
    vi.useFakeTimers()
    try {
      const pending = officialDownload('https://github.com/file', 4, async () => {}, async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
      const assertion = expect(pending).rejects.toMatchObject({ code: 'network' })
      await vi.advanceTimersByTimeAsync(60_001)
      await assertion
    } finally { vi.useRealTimers() }
  })
  it.each(['yt-dlp.exe', 'yt-dlp_macos', 'yt-dlp_x86.exe', 'yt-dlp_arm64.exe'] as const)('requires exactly one strictly named checksum for %s', asset => {
    const hash = 'a'.repeat(64)
    expect(releaseChecksum(`${hash}  ${asset}\n${hash}  yt-dlp_linux\n`, asset)).toBe(hash)
    for (const text of [`${hash}  ${asset}\n${hash} *${asset}`, `${hash}  ../${asset}`, `bad  ${asset}`, `${hash}  ${asset}.old`, `${hash}  ${asset} `])
      expect(() => releaseChecksum(text, asset)).toThrow()
  })
  it('rejects malformed manifest entries instead of accepting arbitrary paths', () => {
    for (const text of ['null', '[]', '{"schema":1,"url":"https://evil.invalid"}', '{"schema":1,"active":{"id":"C:/evil.exe","version":"2026.10.21","sha256":"' + 'a'.repeat(64) + '"}}']) expect(() => parseManagedManifest(text)).toThrow()
  })
})
