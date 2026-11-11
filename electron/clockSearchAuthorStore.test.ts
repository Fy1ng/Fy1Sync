import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClockSearchAuthorStore } from '../scripts/clock-search-authoring/authorStore'

const initial = { schemaVersion: 1, configured: false, roi: null }
const roi = { x: .3, y: .01, w: .4, h: .2 }
let directory = '', file = ''
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy1sync-author-store-'))
  file = join(directory, 'basicSearchRegion.json')
  await writeFile(file, JSON.stringify(initial))
})
async function removeTemporary(target: string): Promise<void> {
  if (!directory || dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('fy1sync-author-store-')) {
    throw new Error('Invalid temporary author test directory')
  }
  const distance = relative(directory, target)
  if (isAbsolute(distance) || distance === '..' || distance.startsWith('..' + sep)) throw new Error('Invalid author test cleanup target')
  await rm(target, { recursive: true, force: true })
}
afterEach(async () => { await removeTemporary(directory) })

describe('one-time author search configuration', () => {
  it('reads the fixed target without changing it or creating author files', async () => {
    expect(await new ClockSearchAuthorStore(file).getState()).toEqual({ config: initial, writable: true, configPath: file })
    expect(await readdir(directory)).toEqual(['basicSearchRegion.json'])
  })

  it('atomically saves valid coordinates, keeps the JSON newline and locks both this and future tools', async () => {
    const store = new ClockSearchAuthorStore(file)
    const result = await store.save(roi)
    expect(result).toMatchObject({ config: { schemaVersion: 1, configured: true, roi }, writable: false })
    const text = await readFile(file, 'utf8')
    expect(text).toBe(JSON.stringify(result.config, null, 2) + '\n')
    await expect(store.save({ ...roi, y: .02 })).rejects.toThrow('已保存并锁定')
    const restarted = new ClockSearchAuthorStore(file)
    expect((await restarted.getState()).writable).toBe(false)
    await expect(restarted.save({ ...roi, y: .02 })).rejects.toThrow('已经设定并锁定')
    expect(await readFile(file, 'utf8')).toBe(text)
    expect(await readdir(directory)).toEqual(['basicSearchRegion.json'])
  })

  it('permits exactly one explicit reset write while preserving the original config until save', async () => {
    await new ClockSearchAuthorStore(file).save(roi)
    const previous = await readFile(file, 'utf8')
    const reset = new ClockSearchAuthorStore(file, true)
    expect((await reset.getState()).writable).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(previous)
    await reset.save({ ...roi, x: .2 })
    await expect(reset.save(roi)).rejects.toThrow('已保存并锁定')
    expect(JSON.parse(await readFile(file, 'utf8')).roi.x).toBe(.2)
  })

  it('rejects invalid, extra-key and dynamic ROI values before touching the target', async () => {
    const store = new ClockSearchAuthorStore(file)
    const previous = await readFile(file, 'utf8')
    const dynamic = { ...roi }
    Object.defineProperty(dynamic, 'x', { enumerable: true, get() { throw new Error('must not execute') } })
    for (const value of [null, [], { ...roi, path: 'elsewhere.json' }, { ...roi, w: 0 }, { ...roi, x: .9 }, { ...roi, y: NaN }, dynamic]) {
      await expect(store.save(value)).rejects.toThrow('生产寻找区间配置无效')
    }
    expect(await readFile(file, 'utf8')).toBe(previous)
    expect(await readdir(directory)).toEqual(['basicSearchRegion.json'])
    await expect(store.save(roi)).resolves.toMatchObject({ writable: false })
  })

  it('serializes duplicate save requests and refuses another active author lock', async () => {
    const store = new ClockSearchAuthorStore(file)
    const attempts = await Promise.allSettled([store.save(roi), store.save({ ...roi, x: .2 })])
    expect(attempts.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await writeFile(file, JSON.stringify(initial))
    await writeFile(file + '.author-lock', JSON.stringify({ pid: process.pid }))
    await expect(new ClockSearchAuthorStore(file).save(roi)).rejects.toThrow('另一个制作工具正在写入配置')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(initial)
  })

  it('does not silently repair or overwrite a malformed or oversized production config', async () => {
    for (const text of ['{bad', JSON.stringify({ ...initial, extra: true }), 'x'.repeat(16_385)]) {
      await writeFile(file, text)
      const store = new ClockSearchAuthorStore(file, true)
      await expect(store.getState()).rejects.toThrow()
      await expect(store.save(roi)).rejects.toThrow()
      expect(await readFile(file, 'utf8')).toBe(text)
      expect(await readdir(directory)).toEqual(['basicSearchRegion.json'])
    }
  })

  it('rejects a directory target and a linked parent without writing outside the target directory', async () => {
    await rm(file)
    await mkdir(file)
    await expect(new ClockSearchAuthorStore(file).save(roi)).rejects.toThrow('普通配置文件')
    await removeTemporary(file)
    const actual = join(directory, 'actual')
    await mkdir(actual)
    await writeFile(join(actual, 'basicSearchRegion.json'), JSON.stringify(initial))
    const linked = join(directory, 'linked')
    await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new ClockSearchAuthorStore(join(linked, 'basicSearchRegion.json')).save(roi)).rejects.toThrow('目录不能是链接')
    expect(JSON.parse(await readFile(join(actual, 'basicSearchRegion.json'), 'utf8'))).toEqual(initial)
  })
})
