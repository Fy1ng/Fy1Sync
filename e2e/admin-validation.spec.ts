/** Read-only acceptance exercises a separate real decoder and the production WASM recognizer. */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page } from '@playwright/test'
import { createEmptyHudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { chooseEditorVideo, failOnPageError, fixturesReady, invoke } from './helpers'

const official = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

async function open(page: Page, app: ElectronApplication) {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(app, page, official)
  await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
  for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) await page.locator('.roi-fields input').nth(index).fill(String(value))
}
async function seek(page: Page, at: number) {
  await page.locator('video.editor-media').evaluate(async (video: HTMLVideoElement, time) => {
    if (Math.abs(video.currentTime - time) < 1e-6 && !video.seeking) return
    await new Promise<void>(resolve => {
      video.addEventListener('seeked', () => resolve(), { once: true })
      video.currentTime = time
    })
  }, at)
  await expect(page.locator('.glyph-box')).toHaveCount(4)
}
async function packHash(page: Page) {
  const saved = await invoke(page, 'editorProjectLoad', undefined)
  if (!saved.ok || !saved.value.project) throw new Error('Expected a saved editor project')
  return createHash('sha256').update(JSON.stringify(saved.value.project.pack)).digest('hex')
}
async function waitForSamples(page: Page, count: number) {
  await expect.poll(async () => {
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    return saved.ok && saved.value.project ? Object.values(saved.value.project.pack.variants[0]!.fields.clock!.glyphs).flat().length : -1
  }).toBe(count)
}

test('只读批量验收连续读取不同帧, 原图回看和跳转不写样本, 退出后仍可撤回制作', async ({ page, electronApp }, testInfo) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  for (let at = 1; at <= 8; at++) {
    await seek(page, at + 0.5)
    await page.locator('.glyph-box').first().click()
    for (const char of `0:${20 - at}`) await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
  }
  await waitForSamples(page, 32)
  const original = await packHash(page)
  const sourceTime = await page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.currentTime)
  await page.getByRole('button', { name: '只读批量验收', exact: true }).click()
  const panel = page.getByRole('region', { name: '只读批量验收', exact: true })
  await expect(panel).toBeVisible()
  await expect(page.locator('.editor-bar')).toHaveAttribute('inert', '')
  await expect(page.locator('.editor-rail')).toBeHidden()
  await panel.getByRole('spinbutton', { name: '验收开始时间' }).fill('1.5')
  await panel.getByRole('spinbutton', { name: '验收结束时间' }).fill('5.5')
  await panel.getByRole('button', { name: '开始验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '验收完成' })).toHaveText('验收完成: 4 / 4 帧', { timeout: 30_000 })
  await expect(page.locator('video.validation-decoder')).toHaveCount(0)
  expect(await page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(sourceTime)
  expect(await packHash(page)).toBe(original)
  await panel.getByRole('button', { name: '全部', exact: true }).click()
  for (let index = 0; index < 4; index++) {
    await expect(panel.getByRole('button', { name: `查看 ${(index + 1.5).toFixed(2)}s 验收结果` })).toContainText(`0:${19 - index}`)
  }
  await page.keyboard.press('Control+z')
  expect(await packHash(page)).toBe(original)
  await panel.getByRole('button', { name: '查看 2.50s 验收结果' }).click()
  await expect(panel.getByRole('img', { name: '倒计时原始画面', exact: true })).toBeVisible()
  await expect(panel.getByRole('region', { name: '验收帧详情' })).toContainText('0:18')
  await expect(page.locator('video.validation-decoder')).toHaveCount(0)
  await panel.getByRole('button', { name: '回到此帧' }).click()
  await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(2.5, 3)
  expect(await packHash(page)).toBe(original)
  await panel.getByRole('heading', { name: '只读批量验收', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('read-only-validation.png') })
  await panel.getByRole('img', { name: '倒计时原始画面', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('read-only-validation-detail.png') })
  await page.setViewportSize({ width: 620, height: 900 })
  await expect(panel.getByRole('button', { name: '返回制作' })).toBeVisible()
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
  await panel.getByRole('heading', { name: '只读批量验收', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('read-only-validation-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 850 })
  await panel.getByRole('button', { name: '返回制作' }).click()
  await expect(page.locator('.editor-bar')).not.toHaveAttribute('inert', '')
  await expect(page.getByRole('button', { name: '撤回', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await waitForSamples(page, 31)
})

test('未训练样式仍扫完整段, 停止保留部分结果, 重新验收不污染草稿', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  await seek(page, 1.5)
  await waitForSamples(page, 0)
  const original = await packHash(page)
  await page.getByRole('button', { name: '只读批量验收', exact: true }).click()
  const panel = page.getByRole('region', { name: '只读批量验收', exact: true })
  await panel.getByRole('spinbutton', { name: '验收开始时间' }).fill('1.5')
  await panel.getByRole('spinbutton', { name: '验收结束时间' }).fill('6.5')
  await panel.getByRole('button', { name: '开始验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '验收完成' })).toHaveText('验收完成: 5 / 5 帧', { timeout: 30_000 })
  await expect(panel.getByRole('list', { name: '验收结果', exact: true }).getByRole('listitem')).toHaveCount(5)
  await expect(panel.getByRole('button', { name: '查看 5.50s 验收结果' })).toContainText('识别失败')
  expect(await packHash(page)).toBe(original)

  await panel.getByRole('button', { name: '选择全片' }).click()
  await panel.getByRole('combobox', { name: '验收抽样间隔' }).selectOption('0.5')
  // The tiny fixture can finish before an external click is dispatched. Stop through the
  // real button as soon as the first rendered progress update arrives, without slowing OCR.
  await panel.evaluate(node => {
    const observer = new MutationObserver(() => {
      const progress = node.querySelector('progress')
      const stop = [...node.querySelectorAll('button')].find(button => button.textContent === '停止验收')
      if (progress && progress.value > 0 && progress.value < progress.max && stop) {
        observer.disconnect()
        stop.click()
      }
    })
    observer.observe(node, { subtree: true, childList: true, attributes: true })
  })
  await panel.getByRole('button', { name: '重新验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '已停止验收' })).toBeVisible()
  const progress = panel.getByRole('progressbar')
  expect(Number(await progress.getAttribute('value'))).toBeGreaterThan(0)
  expect(Number(await progress.getAttribute('value'))).toBeLessThan(Number(await progress.getAttribute('max')))
  await expect(page.locator('video.validation-decoder')).toHaveCount(0)
  expect(await packHash(page)).toBe(original)
  await panel.getByRole('spinbutton', { name: '验收开始时间' }).fill('1.5')
  await panel.getByRole('spinbutton', { name: '验收结束时间' }).fill('2.5')
  await panel.getByRole('combobox', { name: '验收抽样间隔' }).selectOption('1')
  await panel.getByRole('button', { name: '重新验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '验收完成' })).toHaveText('验收完成: 1 / 1 帧')
  expect(await packHash(page)).toBe(original)
})

test('批量验收支持不同参考分辨率并显示实际帧裁切', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  const pack = createEmptyHudStylePack('test/reference-layout', '参考布局测试', { width: 1920, height: 1080 })
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles({ name: 'reference-layout.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) })
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('已导入')
  await expect(page.getByTestId('layout-scaled-frame')).toContainText('1280x720')
  const original = await packHash(page)
  await page.getByRole('button', { name: '只读批量验收', exact: true }).click()
  const panel = page.getByRole('region', { name: '只读批量验收', exact: true })
  await panel.getByRole('spinbutton', { name: '验收开始时间' }).fill('1.5')
  await panel.getByRole('spinbutton', { name: '验收结束时间' }).fill('2.5')
  await panel.getByRole('button', { name: '开始验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '验收完成' })).toHaveText('验收完成: 1 / 1 帧')
  await expect(panel.getByRole('button', { name: '查看 1.50s 验收结果' })).toContainText('official-top-1080')
  await expect(panel.getByRole('button', { name: '查看 1.50s 验收结果' })).not.toContainText('没有匹配布局')
  await panel.getByRole('button', { name: '查看 1.50s 验收结果' }).click()
  await expect(panel.getByRole('img', { name: '原始整帧原始画面' })).toBeVisible()
  await expect(panel.getByRole('img', { name: '倒计时原始画面', exact: true })).toBeVisible()
  expect(await packHash(page)).toBe(original)
})
