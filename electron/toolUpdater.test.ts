import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedYtdlp, officialDownload, parseManagedManifest, releaseChecksum } from './toolUpdater'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-update-')); roots.push(root)
  const network = { version: '2026.10.21', bytes: Buffer.from('verified executable fixture'), wrongHash: false, fail: false }
  const transport = vi.fn(async (url: string) => {
    if (network.fail) throw new Error('private upstream URL/token/local path must stay private')
    const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${network.version}/`
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: network.version, draft: false, prerelease: false,
      assets: [{ name: 'yt-dlp.exe', browser_download_url: base + 'yt-dlp.exe', size: network.bytes.length }, { name: 'SHA2-256SUMS', browser_download_url: base + 'SHA2-256SUMS', size: 80 }] }))
    if (url === base + 'SHA2-256SUMS') return new Response(`${network.wrongHash ? 'a'.repeat(64) : createHash('sha256').update(network.bytes).digest('hex')}  yt-dlp.exe\n`)
    if (url === base + 'yt-dlp.exe') return new Response(network.bytes)
    throw new Error('unexpected test URL')
  })
  const verify = vi.fn(async () => network.version)
  const updater = new ManagedYtdlp(root, { transport, verify })
  return { root, network, transport, verify, updater }
}
describe('managed yt-dlp updater', () => {
  it('does no startup network request and atomically activates a verified version', async () => {
    const f = await fixture()
    expect(await f.updater.activePath()).toBeUndefined()
    expect(f.transport).not.toHaveBeenCalled()
    expect((await f.updater.update()).phase).toBe('ready')
    const selected = await f.updater.activePath()
    expect(await readFile(selected!)).toEqual(f.network.bytes)
    expect(f.verify).toHaveBeenCalledOnce()
    const restarted = new ManagedYtdlp(f.root)
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
    expect(await new ManagedYtdlp(f.root).activePath()).toBeUndefined()
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
      expect(await new ManagedYtdlp(f.root).activePath()).toBeUndefined()
    }
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it('falls back to a hash-verified previous version after an active file is corrupted', async () => {
    const f = await fixture(); await f.updater.update()
    const old = await f.updater.activePath()
    f.network.version = '2026.10.22'; f.network.bytes = Buffer.from('second executable'); await f.updater.update()
    await writeFile((await f.updater.activePath())!, 'damaged')
    expect(await new ManagedYtdlp(f.root).activePath()).toBe(old)
    await writeFile(old!, 'also damaged')
    expect(await new ManagedYtdlp(f.root).activePath()).toBeUndefined()
  })
  it('never downgrades a newer managed version or downloads an already bundled stable version', async () => {
    const f = await fixture()
    const updater = new ManagedYtdlp(f.root, { transport: f.transport, verify: f.verify, baselineVersion: '2026.10.21' })
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
    expect((await new ManagedYtdlp(f.root, { transport, verify: f.verify }).update()).phase).toBe('error')
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
  it('requires exactly one strictly named checksum', () => {
    const hash = 'a'.repeat(64)
    expect(releaseChecksum(`${hash}  yt-dlp.exe\n${hash}  yt-dlp_linux\n`)).toBe(hash)
    for (const text of [`${hash}  yt-dlp.exe\n${hash} *yt-dlp.exe`, `${hash}  ../yt-dlp.exe`, 'bad  yt-dlp.exe']) expect(() => releaseChecksum(text)).toThrow()
  })
  it('rejects malformed manifest entries instead of accepting arbitrary paths', () => {
    for (const text of ['null', '[]', '{"schema":1,"url":"https://evil.invalid"}', '{"schema":1,"active":{"id":"C:/evil.exe","version":"2026.10.21","sha256":"' + 'a'.repeat(64) + '"}}']) expect(() => parseManagedManifest(text)).toThrow()
  })
})
