import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SavedRoomImages } from './savedRoomImages'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw6kAAAAASUVORK5CYII=', 'base64')
const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-image-test-'))
  roots.push(root)
  return { root, images: new SavedRoomImages(root) }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('room-image-test-')) throw new Error('Unexpected image fixture path')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
describe('local favorite avatar cache', () => {
  it('serves a persisted image after restart with a fixed MIME type and no remote URL access', async () => {
    const f = fixture()
    const url = await f.images.cache('https://apic.douyucdn.cn/avatar.png', async () => new Response(PNG), new AbortController().signal)
    expect(url).toMatch(/^\/room-image\/[a-f0-9]{64}\.png$/)
    const response = new SavedRoomImages(f.root).response(new Request('app://app' + url))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
    expect(f.images.response(new Request('app://app/room-image/.%2e/private.json')).status).toBe(404)
    expect(f.images.response(new Request('app://app/room-image/https://evil.test/avatar')).status).toBe(404)
  })

  it('rejects oversized responses, HTML and SVG without writing them', async () => {
    const f = fixture(), signal = new AbortController().signal
    for (const response of [new Response('<svg onload="alert(1)"/>'), new Response('<html>验证页面</html>'), new Response(PNG, { headers: { 'Content-Length': '300000' } })]) {
      expect(await f.images.cache('https://apic.douyucdn.cn/a', async () => response, signal)).toBeNull()
    }
    expect(fs.readdirSync(f.root)).toEqual([])
  })

  it('keeps referenced and recently created images and removes old unreferenced avatars', async () => {
    const f = fixture(), signal = new AbortController().signal
    const url = (await f.images.cache('https://apic.douyucdn.cn/a', async () => new Response(PNG), signal))!
    f.images.prune(new Set())
    expect(f.images.response(new Request('app://app' + url)).status).toBe(200)
    const file = path.join(f.root, 'rooms', 'images', path.basename(url))
    fs.utimesSync(file, new Date(0), new Date(0))
    f.images.prune(new Set([url]))
    expect(fs.existsSync(file)).toBe(true)
    f.images.prune(new Set())
    expect(fs.existsSync(file)).toBe(false)
  })
})
