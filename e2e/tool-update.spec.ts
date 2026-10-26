import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './electron'
import { fixturesReady, invoke, loadBothFixtures, mediaTimes, openSettings, setPlaying } from './helpers'
const fixture = fileURLToPath(new URL('../.packaging/tools/yt-dlp.exe', import.meta.url))
test('工具更新离线回归并保留播放', async ({ page, electronApp }) => {
  test.skip(!existsSync(fixture), 'Run npm run tools:prepare to create the pinned offline executable fixture')
  test.skip(!fixturesReady(), 'Run npm run fixtures to prepare local playback media')
  let externalRequests = 0
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests++ })
  const configure = async (outcome: 'success' | 'hash-mismatch' | 'network-error') => {
    await electronApp.evaluate(async (_electron, args) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const bytes = await fs.readFile(args.fixture)
      const hook = (globalThis as unknown as { __streamSyncerTest: { setToolUpdateFixture(bytes: Uint8Array, outcome: string): void } }).__streamSyncerTest
      hook.setToolUpdateFixture(bytes, args.outcome)
    }, { fixture, outcome })
  }
  await loadBothFixtures(page)
  await setPlaying(page, true)
  const mediaBefore = await mediaTimes(page)
  const dialog = await openSettings(page, '取流工具')
  await expect(dialog).toBeVisible()
  const section = dialog.getByRole('region', { name: '取流工具' })
  const update = section.getByRole('button', { name: '更新 yt-dlp', exact: true })
  await expect(update).toBeEnabled()
  await configure('hash-mismatch')
  await update.click()
  await expect(section.getByRole('status')).toContainText('SHA256 校验失败')
  const before = await invoke(page, 'getToolsStatus', undefined)
  expect(before.ok && before.value.update.activeVersion).toBeFalsy()
  await configure('success')
  await update.click()
  await expect.poll(async () => { const r = await invoke(page, 'getToolsStatus', undefined); return r.ok ? r.value.update.phase : 'ipc-error' }).toBe('ready')
  await expect(update).toBeEnabled()
  const after = await invoke(page, 'getToolsStatus', undefined)
  expect(after.ok && after.value.update.activeVersion).toBe('2026.10.21')
  await section.getByRole('button', { name: '恢复内置版本' }).click()
  await expect(section.getByRole('status')).toContainText('已恢复选择')
  await configure('network-error')
  await update.click()
  await expect(section.getByRole('status')).toContainText('更新下载失败')
  const mediaAfter = await mediaTimes(page)
  expect(mediaAfter.paused).toBe(false)
  expect(mediaAfter.official).toBeGreaterThan(mediaBefore.official)
  expect(mediaAfter.commentary).toBeGreaterThan(mediaBefore.commentary)
  expect(externalRequests).toBe(0)
})
