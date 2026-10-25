import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BufferRoute } from './bufferRoute'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer-route-'))
  roots.push(root)
  const sessionRoot = path.join(root, 'session-1'), directory = path.join(sessionRoot, 'official')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'index.m3u8'), '#EXTM3U\n')
  await writeFile(path.join(directory, 'segment_0_000000000.ts'), '0123456789')
  const route = new BufferRoute('session-1', sessionRoot)
  const url = route.activate('official', 'generation-1', directory)
  return { root, sessionRoot, directory, route, url, segment: url.replace('index.m3u8', 'segment_0_000000000.ts') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('syncer-route-')) throw new Error('Invalid fixture cleanup path')
  return rm(root, { recursive: true, force: true })
})) })

describe('active buffer capability route', () => {
  it('serves a registered independent stream without granting access to sibling streams', async () => {
    const f = await fixture()
    const id = `stream-${'a'.repeat(32)}` as const
    const directory = path.join(f.sessionRoot, id)
    await mkdir(directory)
    await writeFile(path.join(directory, 'index.m3u8'), '#EXTM3U\n')
    const url = f.route.activate(id, 'extra-generation', directory)
    expect((await f.route.handle(new Request(url))).status).toBe(200)
    const sibling = url.replace(id, `stream-${'b'.repeat(32)}`)
    expect((await f.route.handle(new Request(sibling))).status).toBe(404)
    f.route.deactivate(id)
    expect((await f.route.handle(new Request(url))).status).toBe(404)
    expect((await f.route.handle(new Request(f.url))).status).toBe(200)
  })
  it('serves only published HLS files with no caching', async () => {
    const f = await fixture(), response = await f.route.handle(new Request(f.url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('mpegurl')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('#EXTM3U\n')
  })
  it.each(['bytes=2-5', 'bytes=2-', 'bytes=-3', 'bytes=0-999'])('serves single byte ranges: %s', async range => {
    const f = await fixture(), response = await f.route.handle(new Request(f.segment, { headers: { range } }))
    expect(response.status).toBe(206)
    const expected = { 'bytes=2-5': '2345', 'bytes=2-': '23456789', 'bytes=-3': '789', 'bytes=0-999': '0123456789' }[range]
    expect(await response.text()).toBe(expected)
    expect(Number(response.headers.get('content-length'))).toBe(expected!.length)
  })
  it.each(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,4-5', 'garbage', 'bytes=-', 'bytes=999999999999999999999-'])('rejects invalid ranges: %s', async range => {
    const f = await fixture(), response = await f.route.handle(new Request(f.segment, { headers: { range } }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })
  it('serves HEAD without opening a response stream', async () => {
    const f = await fixture(), response = await f.route.handle(new Request(f.segment, { method: 'HEAD', headers: { range: 'bytes=0-2' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('')
  })
  it('rejects other sessions, roles and generations and invalidates old URLs', async () => {
    const f = await fixture()
    for (const raw of [f.url.replace('session-1', 'session-2'), f.url.replace('/official/', '/commentary/'), f.url.replace('generation-1', 'generation-2')]) expect((await f.route.handle(new Request(raw))).status).toBe(404)
    f.route.activate('official', 'generation-2', f.directory)
    expect((await f.route.handle(new Request(f.url))).status).toBe(404)
    f.route.deactivate('official')
    expect((await f.route.handle(new Request(f.url.replace('generation-1', 'generation-2')))).status).toBe(404)
  })
  it('rejects traversal, encoded separators, absolute paths and private raw manifests', async () => {
    const f = await fixture(), base = f.url.slice(0, -'index.m3u8'.length)
    await writeFile(path.join(f.directory, 'raw_0.m3u8'), 'private')
    for (const filename of ['../index.m3u8', '%2e%2e%2findex.m3u8', '..%5cindex.m3u8', '%252e%252e%252findex.m3u8', '/etc/passwd', 'C:%5cprivate', 'raw_0.m3u8', 'index.m3u8/other', 'segment_0_000000000.ts%00']) {
      expect((await f.route.handle(new Request(base + filename))).status, filename).not.toBe(200)
    }
  })
  it('rejects other origins, query strings and writes', async () => {
    const f = await fixture()
    for (const raw of [f.url.replace('app://app/', 'https://app/'), f.url.replace('app://app/', 'app://evil/'), `${f.url}?path=secret`]) expect((await f.route.handle(new Request(raw))).status).toBe(403)
    expect((await f.route.handle(new Request(f.url, { method: 'POST' }))).status).toBe(405)
  })
  it('refuses a role directory outside the session at registration', async () => {
    const f = await fixture()
    expect(() => f.route.activate('official', 'other', f.root)).toThrow('invalid buffer directory')
  })
  it('rejects symlinked files and role directories', async () => {
    const f = await fixture(), outside = path.join(f.root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'index.m3u8'), 'secret')
    const commentary = path.join(f.sessionRoot, 'commentary')
    await symlink(outside, commentary, process.platform === 'win32' ? 'junction' : 'dir')
    const url = f.route.activate('commentary', 'generation-c', commentary)
    expect((await f.route.handle(new Request(url))).status).toBe(403)
    expect(await readFile(path.join(outside, 'index.m3u8'), 'utf8')).toBe('secret')
  })
})
