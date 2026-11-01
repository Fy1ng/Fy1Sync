import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyHudStylePack } from '../src/core/hudStylePack'
import { EditorProjectManager, installEditorProjectIpc } from './editorProject'
import type { EditorLocalMedia, EditorProject } from './editorProjectContracts'

const testRoot = path.resolve(process.env.STREAM_SYNC_TEST_TEMP_DIR ?? tmpdir(), 'fy1sync-editor-project-tests')
const roots: string[] = []
async function fixture() {
  await fs.mkdir(testRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(testRoot, 'case-'))
  roots.push(root)
  const chooseFile = vi.fn<() => Promise<string | null>>(async () => null)
  const options = { userDataDirectory: root, chooseFile }
  return { root, chooseFile, options, manager: new EditorProjectManager(options) }
}
function project(media: EditorLocalMedia): EditorProject {
  const pack = createEmptyHudStylePack()
  return { version: 1, pack, variantId: pack.variants[0]!.id, media: [media], currentMediaId: media.id }
}
async function seed(root: string, value: EditorProject) {
  await fs.mkdir(path.join(root, 'editor'), { recursive: true })
  await fs.writeFile(path.join(root, 'editor/current-project.json'), JSON.stringify(value))
}
async function picked() {
  const f = await fixture()
  const file = path.join(f.root, 'sample.mp4')
  await fs.writeFile(file, '0123456789')
  f.chooseFile.mockResolvedValue(file)
  const chosen = (await f.manager.choose())!
  return { ...f, file, chosen }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== testRoot || !path.basename(root).startsWith('case-')) throw new Error('unexpected project test root')
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('current editor project', () => {
  it('keeps the restored playback URL usable through repeated and concurrent project reads', async () => {
    const f = await picked()
    await f.manager.save(project(f.chosen.media))
    const restarted = new EditorProjectManager(f.options)
    const first = await restarted.load()
    const originalUrl = first.media!.url
    const subsequent = await Promise.all([restarted.load(), restarted.load(), restarted.load()])
    for (const value of subsequent) expect(value.media?.url).toBe(originalUrl)
    const range = await restarted.handle(new Request(originalUrl, { headers: { range: 'bytes=4-7' } }))
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('4567')
    expect((await restarted.handle(new Request(originalUrl, { method: 'HEAD' }))).status).toBe(200)
    expect((await f.manager.handle(new Request(originalUrl))).status).toBe(404)
  })

  it('hydrates once when multiple callers restore a cold manager at the same time', async () => {
    const f = await picked()
    await f.manager.save(project(f.chosen.media))
    let release!: () => void
    const beforeLoad = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const restarted = new EditorProjectManager({ ...f.options, beforeLoad })
    const pending = Array.from({ length: 4 }, () => restarted.load())
    expect(beforeLoad).toHaveBeenCalledOnce()
    release()
    const values = await Promise.all(pending)
    expect(new Set(values.map(value => value.media?.url)).size).toBe(1)
    expect((await restarted.handle(new Request(values[0]!.media!.url, { method: 'HEAD' }))).status).toBe(200)
    expect(beforeLoad).toHaveBeenCalledOnce()
  })

  it('does not revoke a fresh picker grant when an observer reads the project before autosave', async () => {
    const f = await picked()
    const chosen = f.chosen
    expect(await f.manager.load()).toMatchObject({ project: null, media: null })
    const body = await f.manager.handle(new Request(chosen.url, { headers: { range: 'bytes=0-3' } }))
    expect(body.status).toBe(206)
    expect(await body.text()).toBe('0123')
    await expect(f.manager.save(project(chosen.media))).resolves.toEqual({ ok: true })
    expect((await f.manager.load()).media?.url).toBe(chosen.url)
  })

  it('reads the latest completed save without rolling memory back to an older disk snapshot', async () => {
    const f = await picked()
    const value = project(f.chosen.media)
    await f.manager.save(value)
    const saving = f.manager.save({ ...value, pack: { ...value.pack, name: 'latest save' } })
    const read = f.manager.load()
    await saving
    expect((await read).project?.pack.name).toBe('latest save')
    expect((await f.manager.load()).project?.pack.name).toBe('latest save')
    expect((await f.manager.restore(f.chosen.media.id)).media?.url).toBe(f.chosen.url)
  })

  it('starts empty and restores unpublished edits, layout, media metadata and local video after restart', async () => {
    const f = await picked()
    expect(await f.manager.load()).toEqual({ project: null, media: null, needsRelink: false })
    const chosen = (await f.manager.choose())!
    const value = project(chosen.media)
    value.pack.name = '未发布的修改'
    value.media[0]!.match = 'PGL / A vs B / Map 2'
    value.media[0]!.purpose = 'validation'
    value.pack.variants.push({ ...structuredClone(value.pack.variants[0]!), id: 'second' })
    value.variantId = 'second'
    expect(await f.manager.save(value)).toEqual({ ok: true })
    const restarted = new EditorProjectManager(f.options)
    const loaded = await restarted.load()
    expect(loaded.project).toEqual(value)
    expect(loaded.media).toMatchObject({ id: chosen.media.id, url: expect.stringMatching(/^app:\/\/app\/editor-media\//) })
    expect(loaded.needsRelink).toBe(false)
    expect(await (await restarted.handle(new Request(loaded.media!.url))).text()).toBe('0123456789')
    expect(await fs.readdir(path.join(f.root, 'editor'))).toEqual(['current-project.json'])
  })

  it('stores YouTube asset identities without putting machine paths in the style pack', async () => {
    const f = await fixture()
    const pack = createEmptyHudStylePack()
    const value: EditorProject = { version: 1, pack, variantId: pack.variants[0]!.id,
      media: [{ id: 'yt-one', kind: 'youtube', assetId: 'asset-one', name: '一场比赛', match: 'PGL / Map 1', purpose: 'making' }], currentMediaId: 'yt-one' }
    await f.manager.save(value)
    const loaded = await new EditorProjectManager(f.options).load()
    expect(loaded).toEqual({ project: value, media: null, needsRelink: false })
    expect(JSON.stringify(loaded.project!.pack)).not.toContain('asset-one')
  })

  it('awaits media initialization before loading the current project', async () => {
    const f = await fixture()
    const pack = createEmptyHudStylePack()
    const value: EditorProject = { version: 1, pack, variantId: pack.variants[0]!.id, media: [], currentMediaId: null }
    const beforeLoad = vi.fn(async () => {
      await Promise.resolve()
      await seed(f.root, value)
    })
    expect(await new EditorProjectManager({ ...f.options, beforeLoad }).load()).toEqual({ project: value, media: null, needsRelink: false })
    expect(beforeLoad).toHaveBeenCalledOnce()
  })

  it('preserves incomplete draft identity fields but keeps the remaining pack validation strict', async () => {
    const f = await fixture()
    const pack = createEmptyHudStylePack()
    pack.id = ''
    pack.name = ''
    const value: EditorProject = { version: 1, pack, variantId: pack.variants[0]!.id, media: [], currentMediaId: null }
    await f.manager.save(value)
    expect(await new EditorProjectManager(f.options).load()).toMatchObject({ project: value })
    value.pack.id = 'partial/'
    value.pack.name = ' '
    await f.manager.save(value)
    expect(await new EditorProjectManager(f.options).load()).toMatchObject({ project: value })
    await expect(f.manager.save({ ...value, pack: { ...value.pack, id: null } })).rejects.toThrow()
    await expect(f.manager.save({ ...value, pack: { ...value.pack, name: 7 } })).rejects.toThrow()
    await expect(f.manager.save({ ...value, pack: { ...value.pack, schemaVersion: 2 } })).rejects.toThrow()
    await expect(f.manager.save({ ...value, pack: { ...value.pack, variants: [] } })).rejects.toThrow()
  })

  it('prompts on a moved file, relinks the same bytes and keeps its match and purpose', async () => {
    const f = await picked()
    const value = project(f.chosen.media)
    value.media[0]!.match = 'Map 2'
    value.media[0]!.purpose = 'validation'
    await f.manager.save(value)
    const moved = path.join(f.root, 'renamed.mp4')
    await fs.rename(f.file, moved)
    const restarted = new EditorProjectManager(f.options)
    expect(await restarted.load()).toMatchObject({ needsRelink: true, media: null, project: value })
    f.chooseFile.mockResolvedValue(moved)
    const chosen = (await restarted.choose(f.chosen.media.id))!
    expect(chosen.media).toEqual({ ...value.media[0], path: moved })
    expect(await (await restarted.handle(new Request(chosen.url))).text()).toBe('0123456789')
    value.media[0] = chosen.media
    await restarted.save(value)
    expect(await new EditorProjectManager(f.options).load()).toMatchObject({ needsRelink: false, project: value })
  })

  it('prompts when size changes and checks SHA-256 rather than accepting a same-size replacement when relinking', async () => {
    const f = await picked()
    await f.manager.save(project(f.chosen.media))
    await fs.writeFile(f.file, 'changed-size')
    const restarted = new EditorProjectManager(f.options)
    expect(await restarted.load()).toMatchObject({ needsRelink: true })
    await expect(restarted.choose(f.chosen.media.id)).rejects.toMatchObject({ code: 'media-mismatch' })
    await fs.writeFile(f.file, '9876543210')
    await expect(restarted.choose(f.chosen.media.id)).rejects.toMatchObject({ code: 'media-mismatch' })
    await fs.writeFile(f.file, '0123456789')
    expect(await restarted.choose(f.chosen.media.id)).toMatchObject({ media: f.chosen.media })
  })

  it('keeps metadata edits when relinking within the same session', async () => {
    const f = await picked()
    const value = project(f.chosen.media)
    value.media[0]!.match = 'Updated match'
    value.media[0]!.purpose = 'validation'
    await f.manager.save(value)
    expect(await f.manager.choose(f.chosen.media.id)).toMatchObject({ media: value.media[0] })
  })

  it('revokes only a relinked file grant and reuses the replacement route on read', async () => {
    const f = await picked()
    await f.manager.save(project(f.chosen.media))
    const moved = path.join(f.root, 'moved.mp4')
    await fs.rename(f.file, moved)
    f.chooseFile.mockResolvedValue(moved)
    const relinked = (await f.manager.choose(f.chosen.media.id))!
    expect(relinked.url).not.toBe(f.chosen.url)
    // The stale path is deliberately occupied again; the old token must stay revoked.
    await fs.writeFile(f.file, '9876543210')
    expect((await f.manager.handle(new Request(f.chosen.url))).status).toBe(404)
    expect((await f.manager.load()).media?.url).toBe(relinked.url)
    expect(await (await f.manager.handle(new Request(relinked.url))).text()).toBe('0123456789')
  })

  it('does not hash an unchanged-size file again on restore', async () => {
    const f = await picked()
    await f.manager.save(project(f.chosen.media))
    // Restoration follows the manifest's size check; a relink is the explicit hash boundary.
    await fs.writeFile(f.file, 'abcdefghij')
    const restarted = new EditorProjectManager(f.options)
    const loaded = await restarted.load()
    expect(loaded.needsRelink).toBe(false)
    expect(await (await restarted.handle(new Request(loaded.media!.url))).text()).toBe('abcdefghij')
    expect(loaded.project!.media[0]).toMatchObject({ sha256: createHash('sha256').update('0123456789').digest('hex') })
  })

  it('rejects ungranted paths, changed fingerprints, invalid drafts, selections and extra fields without replacing the saved project', async () => {
    const f = await picked()
    const value = project(f.chosen.media)
    await f.manager.save(value)
    for (const patch of [{ path: path.join(f.root, 'private.mp4') }, { size: 9 }, { sha256: 'a'.repeat(64) }, { id: 'forged' }]) {
      const forged = structuredClone(value)
      Object.assign(forged.media[0]!, patch)
      if ('id' in patch) forged.currentMediaId = patch.id!
      await expect(f.manager.save(forged)).rejects.toThrow('工程参数无效')
    }
    await expect(f.manager.save({ ...value, variantId: 'missing' })).rejects.toThrow()
    await expect(f.manager.save({ ...value, currentMediaId: 'missing' })).rejects.toThrow()
    await expect(f.manager.save({ ...value, pack: { ...value.pack, schemaVersion: 2 } })).rejects.toThrow()
    await expect(f.manager.save({ ...value, media: [...value.media, ...value.media] })).rejects.toThrow()
    await expect(f.manager.save({ ...value, extra: true })).rejects.toThrow()
    expect(await new EditorProjectManager(f.options).load()).toMatchObject({ project: value })
    await expect(f.manager.choose('not-granted')).rejects.toMatchObject({ code: 'invalid-arguments' })
    f.chooseFile.mockResolvedValue(null)
    expect(await f.manager.choose()).toBeNull()
  })

  it('retains an unreadable manifest for recovery', async () => {
    const f = await fixture()
    await fs.mkdir(path.join(f.root, 'editor'))
    const file = path.join(f.root, 'editor/current-project.json')
    await fs.writeFile(file, '{broken')
    await expect(f.manager.load()).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe('{broken')
  })
})

describe('selected local media route', () => {
  it.each([['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10']])('streams the requested range %s', async (range, text, contentRange) => {
    const f = await picked()
    const response = await f.manager.handle(new Request(f.chosen.url, { headers: { range, referer: 'app://app/admin' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('content-length')).toBe(String(text.length))
    expect(await response.text()).toBe(text)
  })

  it('supports HEAD, rejects invalid ranges and never reads query paths or unregistered files', async () => {
    const f = await picked()
    const head = await f.manager.handle(new Request(f.chosen.url, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    for (const range of ['bytes=10-', 'bytes=4-3', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
      const response = await f.manager.handle(new Request(f.chosen.url, { headers: { range } }))
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe('bytes */10')
    }
    for (const url of [`${f.chosen.url}?path=${encodeURIComponent(f.file)}`, `${f.chosen.url}#file`, f.chosen.url.replace('app://app', 'https://app'), f.chosen.url.replace('app://app', 'app://evil')]) {
      expect((await f.manager.handle(new Request(url))).status).toBe(403)
    }
    for (const suffix of ['unknown', '../sample.mp4', '%2e%2e%2fsample.mp4', `${f.chosen.media.id}/sample.mp4`]) {
      expect((await f.manager.handle(new Request(`app://app/editor-media/${suffix}`))).status).toBe(404)
    }
    expect((await f.manager.handle(new Request(f.chosen.url, { method: 'POST' }))).status).toBe(405)
    expect((await f.manager.handle(new Request(f.chosen.url, { headers: { referer: 'https://evil/admin' } }))).status).toBe(403)
    expect((await new EditorProjectManager(f.options).handle(new Request(f.chosen.url))).status).toBe(404)
  })

  it('handles offsets above 4 GiB without integer truncation', async () => {
    const f = await fixture()
    const file = path.join(f.root, 'large.mp4')
    const handle = await fs.open(file, 'w')
    const size = 4 * 1024 ** 3 + 20
    await handle.truncate(size)
    await handle.write(Buffer.from('tail'), 0, 4, size - 4)
    await handle.close()
    const media: EditorLocalMedia = { id: 'large', kind: 'local', path: file, size, sha256: 'a'.repeat(64), name: 'large.mp4', match: '', purpose: 'making' }
    await seed(f.root, project(media))
    const loaded = await f.manager.load()
    const response = await f.manager.handle(new Request(loaded.media!.url, { headers: { range: `bytes=${size - 4}-` } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`)
    expect(await response.text()).toBe('tail')
  })

  it('rejects junction aliases and stops serving a replaced file with a different size', async () => {
    const f = await picked()
    const linked = path.join(f.root, 'linked')
    const outside = path.join(f.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'secret.mp4'), 'secret')
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    f.chooseFile.mockResolvedValue(path.join(linked, 'secret.mp4'))
    await expect(f.manager.choose()).rejects.toMatchObject({ code: 'media-unavailable' })
    await fs.writeFile(f.file, 'different length')
    expect((await f.manager.handle(new Request(f.chosen.url))).status).toBe(404)
  })
})

describe('editor project IPC', () => {
  async function ipcFixture() {
    const f = await fixture()
    const owner = Object.assign(new EventEmitter(), { mainFrame: { url: 'app://app/admin' }, isDestroyed: () => false })
    let invoke: (...args: any[]) => Promise<any> = async () => {}
    const ipc = { handle: vi.fn((_channel, handler) => { invoke = handler }), removeHandler: vi.fn() }
    const installed = installEditorProjectIpc(ipc, owner as unknown as WebContents, f.manager)
    const event = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent
    return { ...f, owner, ipc, installed, call: (method: string, args?: unknown) => invoke(event, method, args), invoke, event }
  }

  it('accepts only its native owner top frame on the admin document', async () => {
    const f = await ipcFixture()
    expect(await f.call('editorProjectLoad')).toEqual({ ok: true, value: { project: null, media: null, needsRelink: false } })
    expect(await f.invoke({ ...f.event, sender: { ...f.owner } }, 'editorProjectLoad')).toMatchObject({ code: 'forbidden' })
    expect(await f.invoke({ ...f.event, senderFrame: { url: 'app://app/admin' } }, 'editorProjectLoad')).toMatchObject({ code: 'forbidden' })
    for (const url of ['app://app/', 'app://app/pip', 'https://evil/admin']) {
      f.owner.mainFrame.url = url
      expect(await f.call('editorProjectLoad')).toMatchObject({ code: 'forbidden' })
    }
    f.installed.dispose()
    expect(f.ipc.removeHandler).toHaveBeenCalledWith('stream-syncer:editor-invoke')
  })

  it('has no arbitrary file path argument and sanitizes failures', async () => {
    const f = await ipcFixture()
    for (const [method, args] of [['editorProjectLoad', {}], ['editorMediaChoose', { path: 'C:/secret.mp4' }], ['editorMediaChoose', { relinkId: '../secret' }],
      ['editorMediaRestore', { id: 'x', path: 'secret' }], ['editorMediaRestore', { id: '../secret' }], ['editorProjectSave', { project: {} }],
      ['editorMediaChoose', { get relinkId() { throw new Error('secret') } }]]) {
      expect(await f.call(method as string, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    expect(f.chooseFile).not.toHaveBeenCalled()
    f.chooseFile.mockRejectedValue(new Error('secret/path/that/must/not/leak'))
    expect(await f.call('editorMediaChoose', {})).toEqual({ ok: false, code: 'project-failed', message: '工程读取或保存失败, 原文件已保留.' })
    expect(await f.call('unknown')).toMatchObject({ code: 'unknown-method' })
    f.installed.dispose()
  })
})

describe('project writes', () => {
  it('lands snapshots in order and keeps the last one', async () => {
    const f = await fixture()
    const pack = createEmptyHudStylePack()
    const value = (name: string): EditorProject => ({ version: 1, pack: { ...pack, name }, variantId: pack.variants[0]!.id, media: [], currentMediaId: null })
    await Promise.all(['一', '二', '三'].map(name => f.manager.save(value(name))))
    expect((await new EditorProjectManager(f.options).load()).project?.pack.name).toBe('三')
    expect(await fs.readdir(path.join(f.root, 'editor'))).toEqual(['current-project.json'])
  })
})
