import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from './electron'
import { mediaTimes, openAlignOptions, openPlayer, openSettingsSection, revealOverlay, seekBoth, setPlaying, waitForBothReady } from './helpers'
import { loadRecordingSource } from './recordingSources'

test('播放器可切换画面匹配、可视化框选并恢复设置, 旧编辑器接口不再暴露', async ({ page }) => {
  await openPlayer(page)
  await revealOverlay(page)
  await page.getByRole('button', { name: '对齐选项' }).click()
  await expect(page.getByRole('radio', { name: '基础模式' })).toBeChecked()
  await page.getByRole('radio', { name: '画面匹配' }).locator('..').click()
  await expect(page.getByRole('radio', { name: '画面匹配' })).toBeChecked()
  await expect(page.getByRole('radio', { name: '样式包模式' })).toHaveCount(0)
  await page.getByRole('button', { name: '调整匹配区域', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings.getByRole('tabpanel', { name: '画面匹配', exact: true })).toBeVisible()

  // Visually drag a crop box on the official canvas.
  const officialStage = settings.getByLabel('画面裁剪画布')
  const bounds = await officialStage.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * 0.1, bounds!.y + bounds!.height * 0.1)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width * 0.9, bounds!.y + bounds!.height * 0.9, { steps: 5 })
  await page.mouse.up()

  await settings.getByRole('button', { name: '添加忽略区域' }).click()
  await expect(settings.getByRole('group', { name: '画面画布忽略区域 1' })).toBeVisible()
  await expect(settings.getByRole('group', { name: '解说画布忽略区域 1' })).toBeVisible()

  await settings.getByText('精确百分比微调', { exact: true }).click()
  await expect(settings.getByRole('spinbutton', { name: '画面区域左侧百分比' })).toHaveValue('10')
  await expect(settings.getByRole('spinbutton', { name: '忽略区域 1顶部百分比' })).toBeVisible()

  const rejected = await page.evaluate(async () => {
    const bridge = window.streamSyncer!
    return Promise.all(['savePreset', 'syncStylePacks', 'editorProjectLoad', 'ytBrowseOpen'].map(method =>
      bridge.invoke(method as Parameters<typeof bridge.invoke>[0], undefined)))
  })
  for (const result of rejected) expect(result).toMatchObject({ ok: false, code: 'unknown-method' })
  const removedRoutes = await page.evaluate(() => Promise.all(['/admin', '/admin-media/old', '/editor-media/old']
    .map(async path => (await fetch(path)).status)))
  expect(removedRoutes).toEqual([404, 404, 404])
  await page.reload()
  await openPlayer(page)
  const restored = await openSettingsSection(page, '画面匹配')
  await restored.getByText('精确百分比微调', { exact: true }).click()
  await expect(restored.getByRole('spinbutton', { name: '画面区域左侧百分比' })).toHaveValue('10')
  await expect(restored.getByRole('spinbutton', { name: '忽略区域 1顶部百分比' })).toBeVisible()
  await expect(restored.getByRole('link', { name: /编辑器/ })).toHaveCount(0)
})

test('画面匹配校正同一运动画面的已知偏差, 并用新画面复核', async ({ page }, testInfo) => {
  const file = testInfo.outputPath('motion.mp4')
  await promisify(execFile)(process.env.STREAM_SYNC_FIXTURE_FFMPEG || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
    'color=c=gray:s=32x18:r=24,format=gray,noise=alls=90:allf=t+u:all_seed=73,scale=512:288:flags=neighbor',
    '-t', '45', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file,
  ], { windowsHide: true, timeout: 30_000 })
  await openPlayer(page)
  for (const role of ['official', 'commentary'] as const) {
    await loadRecordingSource(page, role, file)
  }
  await waitForBothReady(page)
  await setPlaying(page, false)
  await seekBoth(page, 9, 6)
  const options = await openAlignOptions(page)
  await options.getByRole('radio', { name: '画面匹配' }).locator('..').click()
  await page.keyboard.press('Escape')
  await setPlaying(page, true)
  await expect.poll(async () => (await mediaTimes(page)).commentary).toBeGreaterThan(11)
  await revealOverlay(page)
  await page.getByRole('button', { name: '自动对齐', exact: true }).click()
  const result = (await openAlignOptions(page)).locator('.menu-meta').last()
  await expect(result).toContainText('复核误差', { timeout: 35_000 })
  const reading = /上次测得偏差\s+([+-]?[\d.]+).*复核误差\s+([+-]?[\d.]+)/.exec(await result.innerText())
  expect(reading).not.toBeNull()
  expect(Math.abs(Number(reading![1]) - 3)).toBeLessThan(0.35)
  expect(Math.abs(Number(reading![2]))).toBeLessThan(0.35)
  expect(Math.abs((await mediaTimes(page)).lag)).toBeLessThan(0.35)
})
