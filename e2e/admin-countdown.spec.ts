/** Button-only teaching, persistent deduplication and the shared editor undo history. */
import { fileURLToPath } from 'node:url'
import type { ElectronApplication, Page } from '@playwright/test'
import { APP_ORIGIN, expect, test } from './electron'
import { chooseEditorVideo, failOnPageError, fixturesReady, invoke } from './helpers'

const fixture = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

async function seek(page: Page, time: number) {
  await page.locator('video.editor-media').evaluate((video: HTMLVideoElement, to) => new Promise<void>(resolve => {
    if (Math.abs(video.currentTime - to) < 1e-6 && !video.seeking) { resolve(); return }
    video.addEventListener('seeked', () => resolve(), { once: true })
    video.currentTime = to
  }), time)
  await expect(page.locator('.glyph-box')).toHaveCount(4)
}
async function open(page: Page, app: ElectronApplication) {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(app, page, fixture)
  await expect.poll(() => page.locator('video.editor-media').evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2)
  for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) {
    await page.locator('.roi-field input').nth(index).fill(String(value))
  }
  await seek(page, 1)
}
async function label(page: Page, text: string) {
  await page.locator('.glyph-box').first().click()
  for (const char of text) await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
}

test('只有字符按钮即点即存, 更正不叠加, 撤回按钮和 Ctrl+Z 都撤回标注', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  await expect(page.getByRole('textbox', { name: '整帧读数' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '存为样本', exact: true })).toHaveCount(0)
  await page.locator('.glyph-box').first().click()
  await page.keyboard.type('0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(0)
  const reading = page.getByLabel('当前读数', { exact: true })
  for (const [index, char] of ['0', ':', '1', '9'].entries()) {
    await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
    await expect(page.locator('.template-thumb')).toHaveCount(index + 1)
  }
  await expect(reading).toHaveText('0:19')
  await page.locator('.glyph-box').last().click()
  await page.locator('.char-pad').getByRole('button', { name: '8', exact: true }).click()
  await expect(reading).toHaveText('0:18')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(reading).toHaveText('0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  // Repeating an already-saved label must not create either a sample or a no-op undo step.
  await page.locator('.glyph-box').last().click()
  await page.locator('.char-pad').getByRole('button', { name: '9', exact: true }).click()
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('未重复添加')
  await page.locator('.editor-stage').focus()
  await page.keyboard.press('Control+z')
  await expect(reading).toHaveText('0:1?')
  await expect(page.locator('.template-thumb')).toHaveCount(3)
  await expect(page.locator('.glyph-box').last()).toHaveClass(/is-selected/)
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(reading).toHaveText('0:??')
  await expect(page.locator('.template-thumb')).toHaveCount(2)
  // Navigation must never extrapolate stored character labels.
  await page.getByRole('button', { name: '+1s', exact: true }).click()
  await expect(page.locator('.template-thumb')).toHaveCount(2)
  await expect(reading).toHaveText('待标注')
})

test('重新取帧, 返回同一帧和重开工程均不会重复添加样本', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  await label(page, '0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await page.getByRole('button', { name: '取当前帧', exact: true }).click()
  await expect(page.getByLabel('当前读数', { exact: true })).toHaveText('0:19')
  await label(page, '0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await seek(page, 2)
  await seek(page, 1)
  await expect(page.getByLabel('当前读数', { exact: true })).toHaveText('0:19')
  await label(page, '0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await page.getByRole('button', { name: '存为草稿', exact: true }).click()
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('已保存到本机草稿')
  await expect.poll(async () => {
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    if (!saved.ok || !saved.value.project) return 0
    return Object.values(saved.value.project.pack.variants[0]!.fields.clock!.glyphs).flat().length
  }).toBe(4)
  await page.reload()
  await expect.poll(() => page.locator('video.editor-media').evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2)
  await seek(page, 1)
  await expect(page.getByLabel('当前读数', { exact: true })).toHaveText('0:19')
  await label(page, '0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '撤回', exact: true })).toBeDisabled()
})

test('跳秒只导航素材, 不推算读数或创建样本, 手动撤回仍返回原标注帧', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  await label(page, '0:19')
  const reading = page.getByLabel('当前读数', { exact: true })
  const video = page.locator('video.editor-media')
  await expect(page.getByRole('button', { name: '自动 +1s', exact: true })).toHaveCount(0)
  await expect(page.getByRole('group', { name: '自动逐秒标注' })).toHaveCount(0)
  for (const [button, time] of [['+1s', 2], ['+10s', 12], ['-1s', 11], ['-10s', 1]] as const) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(time, 2)
    await expect(page.locator('.template-thumb')).toHaveCount(4)
    await expect(reading).toHaveText(time === 1 ? '0:19' : '待标注')
  }
  await page.getByRole('button', { name: '+1s', exact: true }).click()
  await expect(reading).toHaveText('待标注')
  await page.waitForTimeout(500)
  await expect(page.locator('.template-thumb')).toHaveCount(4)
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 2)
  await expect(page.locator('.template-thumb')).toHaveCount(3)
  await expect(reading).toHaveText('0:1?')
})

test('折叠字符面板不会丢失只读倒计时或撤回状态', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  await open(page, electronApp)
  await label(page, '0:19')
  const binary = page.locator('details.rail-collapsible').filter({ has: page.getByRole('heading', { name: '二值化', exact: true }) })
  const glyphs = page.locator('details.rail-collapsible').filter({ has: page.getByRole('heading', { name: '字符', exact: true }) })
  const threshold = page.getByRole('slider', { name: '阈值', exact: true })
  await binary.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(threshold).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(threshold).toHaveValue('150')
  const reading = page.getByLabel('当前读数', { exact: true })
  await glyphs.locator('summary').click()
  await expect(reading).toBeHidden()
  await page.getByRole('button', { name: '+1s', exact: true }).click()
  await expect(glyphs.locator('summary')).toContainText('4 个样本')
  await glyphs.locator('summary').click()
  await expect(reading).toHaveText('待标注')
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(reading).toHaveText('0:1?')
  await expect(page.locator('.template-thumb')).toHaveCount(3)
})
