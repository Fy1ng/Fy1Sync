import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaCapture } from './mediaCapture'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvR0AAAAASUVORK5CYII='
const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncer-capture-test-')); roots.push(root)
  const choose = vi.fn(async (kind: 'png' | 'gif') => path.join(root, `export.${kind}`))
  const encode = vi.fn(async (input: { output: string }) => { await fs.writeFile(input.output, 'GIF89a-fixture') })
  const save = vi.fn()
  const capture = new MediaCapture({ root, load: () => undefined, save, chooseDestination: choose, encode,
    permissions: { protect() {}, verify() {} } })
  return { root, capture, choose, encode, save }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('syncer-capture-test-')) throw new Error('Unsafe fixture cleanup')
    await fs.rm(root, { recursive: true, force: true })
  }
})
describe('opt-in frame capture', () => {
  it('performs no capture work while disabled and saves only the submitted video frame', async () => {
    const f = await fixture()
    await expect(f.capture.screenshot(PNG)).rejects.toMatchObject({ code: 'disabled' })
    expect(f.choose).not.toHaveBeenCalled()
    await f.capture.configure(true)
    const saved = await f.capture.screenshot(PNG)
    expect(saved.status).toBe('saved')
    expect(await fs.readFile(saved.path!)).toEqual(Buffer.from(PNG, 'base64'))
    await f.capture.dispose()
  })
  it('encodes ordered bounded frames and removes private staging afterwards', async () => {
    const f = await fixture(); await f.capture.configure(true)
    const job = f.capture.begin({ fps: 2, seconds: 1, width: 320 })
    await f.capture.append(job.id, 0, PNG)
    await expect(f.capture.append(job.id, 0, PNG)).rejects.toMatchObject({ code: 'invalid-arguments' })
    await f.capture.append(job.id, 1, PNG)
    await expect(f.capture.append(job.id, 2, PNG)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect((await f.capture.finish(job.id)).status).toBe('saved')
    expect(f.encode).toHaveBeenCalledOnce()
    expect(await fs.readdir(path.join(f.root, 'capture-jobs'))).toEqual([])
    await f.capture.dispose()
  })
  it('disabling cancels staged recordings without encoding or exporting', async () => {
    const f = await fixture(); await f.capture.configure(true)
    const job = f.capture.begin({ fps: 2, seconds: 1, width: 320 })
    await f.capture.append(job.id, 0, PNG)
    await f.capture.configure(false)
    expect(f.capture.state().recordings).toEqual([])
    expect(f.encode).not.toHaveBeenCalled()
    expect(f.choose).not.toHaveBeenCalled()
    expect(await fs.readdir(path.join(f.root, 'capture-jobs'))).toEqual([])
    await f.capture.dispose()
  })
  it('rejects forged images and out-of-bound recording options', async () => {
    const f = await fixture(); await f.capture.configure(true)
    await expect(f.capture.screenshot(Buffer.from('not png').toString('base64'))).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(() => f.capture.begin({ fps: 60, seconds: 300, width: 4096 })).toThrow()
    expect(f.choose).not.toHaveBeenCalled()
    await f.capture.dispose()
  })
})
