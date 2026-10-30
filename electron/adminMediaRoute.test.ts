import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AdminMediaRoute } from './adminMediaRoute'

const testRoot = path.resolve('.runtime-cache', `codex-ytimport-impl-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, 'route')
async function fixture(extension = 'mp4') {
  await mkdir(testRoot, { recursive: true })
  const directory = await mkdtemp(path.join(testRoot, 'case-'))
  const root = path.join(directory, 'admin-media')
  const assetDirectory = path.join(root, 'asset-1')
  await mkdir(assetDirectory, { recursive: true })
  const file = path.join(assetDirectory, `media.${extension}`)
  await writeFile(file, '0123456789')
  const route = new AdminMediaRoute(root)
  const url = route.register('asset-1', file)
  return { directory, root, assetDirectory, file, route, url }
}

describe('registered admin media route', () => {
  it.each([['mp4', 'video/mp4']])('serves registered %s only with the correct MIME type', async (extension, type) => {
    const f = await fixture(extension)
    const response = await f.route.handle(new Request(f.url))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('0123456789')
  })

  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=2-', '23456789', 'bytes 2-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=0-999', '0123456789', 'bytes 0-9/10'],
    ['bytes=-999', '0123456789', 'bytes 0-9/10'],
  ])('serves a single range %s', async (range, text, contentRange) => {
    const f = await fixture()
    const response = await f.route.handle(new Request(f.url, { headers: { range } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe(String(text.length))
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(await response.text()).toBe(text)
  })

  it.each(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,4-5', 'garbage', 'bytes=-', 'bytes=999999999999999999999-'])('rejects invalid ranges %s', async range => {
    const f = await fixture()
    const response = await f.route.handle(new Request(f.url, { headers: { range } }))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })

  it('serves HEAD and an empty file without a body', async () => {
    const f = await fixture()
    const response = await f.route.handle(new Request(f.url, { method: 'HEAD', headers: { range: 'bytes=1-3' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-length')).toBe('3')
    expect(await response.text()).toBe('')
    await writeFile(f.file, '')
    const empty = await f.route.handle(new Request(f.url))
    expect(empty.status).toBe(200)
    expect(empty.headers.get('content-length')).toBe('0')
    expect(await empty.text()).toBe('')
    expect((await f.route.handle(new Request(f.url, { headers: { range: 'bytes=0-' } }))).status).toBe(416)
  })

  it('denies unknown IDs, files on disk without registration, and revoked assets', async () => {
    const f = await fixture()
    await mkdir(path.join(f.root, 'asset-2'))
    await writeFile(path.join(f.root, 'asset-2', 'media.mp4'), 'private')
    expect((await f.route.handle(new Request(f.url.replace('asset-1', 'asset-2')))).status).toBe(404)
    f.route.unregister('asset-1')
    expect((await f.route.handle(new Request(f.url))).status).toBe(404)
    f.route.register('asset-1', f.file)
    f.route.clear()
    expect((await f.route.handle(new Request(f.url))).status).toBe(404)
    const fresh = new AdminMediaRoute(f.root)
    expect((await fresh.handle(new Request(f.url))).status).toBe(404)
  })

  it('denies traversal, encoded separators, suffixes, absolute paths and sidecars', async () => {
    const f = await fixture()
    await writeFile(path.join(f.assetDirectory, 'metadata.json'), 'private')
    for (const suffix of ['../metadata.json', '%2e%2e%2fasset-1', '..%5casset-1', '%252e%252e%252fasset-1', '/etc/passwd', 'C:%5cprivate', 'asset-1/media.mp4', 'asset-1%00', 'asset-1/', 'asset-1/metadata.json']) {
      expect((await f.route.handle(new Request(`app://app/admin-media/${suffix}`))).status, suffix).toBe(404)
    }
  })

  it('denies wrong origins, credentials, query parameters, hashes and writes', async () => {
    const f = await fixture()
    for (const url of [f.url.replace('app://app/', 'https://app/'), f.url.replace('app://app/', 'app://evil/'), `${f.url}?path=secret`, `${f.url}#secret`]) {
      expect((await f.route.handle(new Request(url))).status, url).toBe(403)
    }
    expect((await f.route.handle({ ...new Request(f.url), method: 'GET', url: f.url.replace('app://app/', 'app://user:pass@app/') } as Request)).status).toBe(403)
    expect((await f.route.handle(new Request(f.url, { method: 'POST' }))).status).toBe(405)
  })

  it('refuses arbitrary files and directories at registration', async () => {
    const f = await fixture()
    for (const [id, file] of [['../asset-1', f.file], ['asset-1', path.join(f.directory, 'media.mp4')], ['asset-1', path.join(f.assetDirectory, 'metadata.json')], ['asset-2', f.file]]) {
      expect(() => f.route.register(id!, file!)).toThrow('invalid admin media registration')
    }
  })

  it('denies junction or symlink asset directories and roots', async () => {
    const f = await fixture()
    const outside = path.join(f.directory, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'media.mp4'), 'secret')
    const linked = path.join(f.root, 'linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const url = f.route.register('linked', path.join(linked, 'media.mp4'))
    expect((await f.route.handle(new Request(url))).status).toBe(403)
    const linkedRoot = path.join(f.directory, 'linked-root')
    await symlink(f.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const rootRoute = new AdminMediaRoute(linkedRoot)
    const rootUrl = rootRoute.register('asset-1', path.join(linkedRoot, 'asset-1', 'media.mp4'))
    expect((await rootRoute.handle(new Request(rootUrl))).status).toBe(403)
    expect(await readFile(path.join(outside, 'media.mp4'), 'utf8')).toBe('secret')
  })
})
