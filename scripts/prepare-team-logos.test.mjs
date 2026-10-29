import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { loadLogoCache, prepareTeamLogos, validateLogoList } from './prepare-team-logos.mjs'

const list = JSON.parse(await readFile(new URL('../packaging/team-logos.json', import.meta.url), 'utf8'))
const work = await mkdtemp(path.join(process.env.FY1SYNC_LOGO_WORK_DIR ?? tmpdir(), 'logo-preparation-test-'))
const core = await loadLogoCache(path.join(work, 'compiled'))
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
const hash = createHash('sha256').update(png).digest('hex')

async function fixture(name) {
  const destination = path.join(work, name)
  await mkdir(path.join(destination, 'events', 'logos'), { recursive: true })
  for (const team of list.teams) await writeFile(path.join(destination, 'events', 'logos', `${core.teamLogoKey(team.path)}.png`), png)
  return destination
}

test('固定清单有 50 到 100 支连续排名且拒绝重复、外部路径和错误来源', () => {
  assert.equal(validateLogoList(list, core.normalizeLogoPath), list)
  for (const mutate of [
    value => { value.teams[1].path = value.teams[0].path },
    value => { value.teams[0].path = 'https://evil.invalid/logo.png' },
    value => { value.source.url = 'https://evil.invalid/ranking' },
    value => { value.teams.pop(); value.teams = value.teams.slice(0, 49) },
  ]) {
    const value = structuredClone(list); mutate(value)
    assert.throws(() => validateLogoList(value, core.normalizeLogoPath))
  }
})

test('校验有效图片后断点复用, 完整生成来源和哈希, 重跑保留下载时间和图片 mtime', async () => {
  const destination = await fixture('resume')
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ schema: 1, entries: [null, 42, { key: 'corrupt' }] }))
  let requests = 0
  const options = { core, list, destination, cacheDependencies: { request: async () => { requests++; throw Error('Unexpected network') } } }
  const first = await prepareTeamLogos(options)
  assert.equal(first.downloaded, 0); assert.equal(first.skipped, 64); assert.equal(requests, 0)
  const before = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))
  const file = path.join(destination, before.entries[0].file), mtime = (await stat(file)).mtimeMs
  for (const entry of before.entries) {
    assert.equal(entry.sha256, hash); assert.equal(entry.size, png.length)
    assert.equal(entry.key, core.teamLogoKey(entry.path)); assert.equal(entry.sourceUrl, `https://liquipedia.net${entry.path}`)
    assert.ok(Number.isFinite(Date.parse(entry.downloadedAt)))
  }
  await prepareTeamLogos(options)
  const after = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))
  assert.deepEqual(after.entries, before.entries); assert.equal((await stat(file)).mtimeMs, mtime); assert.equal(requests, 0)
})

test('损坏图片不算断点命中, 下载经过生产 MIME 和文件头校验, 失败不能悄悄打包', async () => {
  const destination = await fixture('corrupt')
  const first = list.teams[0], key = core.teamLogoKey(first.path)
  await writeFile(path.join(destination, 'events', 'logos', `${key}.png`), '<svg/>')
  let requests = 0, summary
  await assert.rejects(prepareTeamLogos({ core, list, destination,
    cacheDependencies: { resolve: async () => ['93.184.216.34'], request: async (_input, init) => {
      requests++; assert.equal(init.headers['User-Agent'], 'Fy1Sync/0.2.0 (local desktop app; sync@fy1ng.cn)')
      return new Response('<svg/>', { headers: { 'content-type': 'image/png' } })
    } }, onSummary: value => { summary = value },
  }), /下载或校验失败/)
  assert.equal(requests, 1); assert.equal(summary.total, 63); assert.deepEqual(summary.failures, [first.team])
  assert.equal(core.readTeamLogo(destination, key), null)
})

test('断点只补下载损坏图片, 成功后 manifest 包含实际下载字节和文件位置', async () => {
  const destination = await fixture('repair')
  const key = core.teamLogoKey(list.teams[0].path)
  await writeFile(path.join(destination, 'events', 'logos', `${key}.png`), 'corrupt')
  let requests = 0
  const summary = await prepareTeamLogos({ core, list, destination,
    cacheDependencies: { resolve: async () => ['93.184.216.34'], request: async () => {
      requests++; return new Response(png, { headers: { 'content-type': 'image/png' } })
    } },
  })
  assert.equal(requests, 1); assert.equal(summary.downloaded, 1); assert.equal(summary.skipped, 63)
  assert.equal(summary.total, 64); assert.equal(summary.imageBytes, 64 * png.length)
  assert.deepEqual(core.readTeamLogo(destination, key).bytes, png)
  const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))
  for (const entry of manifest.entries) assert.deepEqual(await readFile(path.join(destination, entry.file)), png)
})
