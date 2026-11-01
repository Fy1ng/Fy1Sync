/** Countdown teaching uses decoded destination frames and a disposable editor project. */
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN, expect, test } from './electron'
import { chooseEditorVideo, failOnPageError, fixturesReady } from './helpers'

const fixture = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

for (const method of ['keyboard', 'pad'] as const) {
  test(`字符框输入倒计时后可自动写入和撤回 (${method})`, async ({ page, electronApp }) => {
    test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(electronApp, page, fixture)
    const video = page.locator('video.editor-media')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)
    for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) {
      await page.locator('.roi-field input').nth(index).fill(String(value))
    }
    await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1 })
    await expect(page.locator('.glyph-box')).toHaveCount(4)
    await page.locator('.glyph-box').first().click()
    if (method === 'keyboard') await page.keyboard.type('0:19')
    else for (const char of ['0', ':', '1', '9']) await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
    const reading = page.getByRole('textbox', { name: '整帧读数' })
    await expect(reading).toHaveValue('0:19')
    await expect(page.locator('.template-thumb')).toHaveCount(4)
    await page.getByRole('button', { name: '+1s', exact: true }).click()
    await expect(reading).toHaveValue('0:18')
    await expect(page.locator('.template-thumb')).toHaveCount(8)
    await page.getByRole('button', { name: '撤回自动写入' }).click()
    await expect(reading).toHaveValue('0:19')
    await expect(page.locator('.template-thumb')).toHaveCount(4)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(1, 2)
    // A new frame cannot complete its clock with labels retained from the previous one.
    await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 2 })
    await expect(reading).toHaveValue('')
    await expect(page.locator('.glyph-box')).toHaveCount(4)
    await page.locator('.glyph-box').last().click()
    await page.keyboard.type('8')
    await expect(page.locator('.template-thumb')).toHaveCount(5)
    await expect(reading).toHaveValue('')
    await page.getByRole('button', { name: '+1s', exact: true }).click()
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(3, 2)
    await expect(page.locator('.template-thumb')).toHaveCount(5)
  })
}

test('倒计时跳转自动存入目标帧, 连续撤回保留手动样本和其他设置', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(electronApp, page, fixture)
  const video = page.locator('video.editor-media')
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)
  for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) {
    await page.locator('.roi-field input').nth(index).fill(String(value))
  }
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1 })
  await expect(page.locator('.glyph-box')).toHaveCount(4)
  // Jump teaching must capture even when ordinary automatic frame capture is off.
  await page.getByRole('switch', { name: '自动取帧', exact: true }).press('Space')
  await expect(page.getByRole('switch', { name: '自动取帧', exact: true })).not.toBeChecked()
  const reading = page.getByRole('textbox', { name: '整帧读数' })
  await reading.fill('0:19')
  for (const [index, [button, time, value]] of ([
    ['+1s', 2, '0:18'], ['+10s', 12, '0:08'], ['-1s', 11, '0:09'], ['-10s', 1, '0:19'],
  ] as const).entries()) {
    await page.getByRole('button', { name: button, exact: true }).click()
    await expect(reading).toHaveValue(value)
    await expect(page.locator('.template-thumb')).toHaveCount((index + 1) * 4)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(time, 2)
    await expect(page.getByRole('button', { name: '撤回自动写入' })).toBeEnabled()
  }
  const lastGlyph = (char: string) => page.locator('.template-cell')
    .filter({ has: page.locator('.template-char', { hasText: new RegExp(`^${char}$`) }) }).locator('.template-thumb canvas').last()
  const automatic = new Map<string, string>()
  for (const char of ['0', ':', '1', '9']) {
    await expect(lastGlyph(char)).toHaveAttribute('width', '32')
    automatic.set(char, await lastGlyph(char).evaluate((node: HTMLCanvasElement) => node.toDataURL()))
  }
  // A fresh manual capture must reproduce the automatically taught target glyphs.
  await page.getByRole('button', { name: '取当前帧', exact: true }).click()
  await expect(page.locator('.glyph-box')).toHaveCount(4)
  await page.getByRole('button', { name: '存为样本', exact: true }).click()
  await expect(page.locator('.template-thumb')).toHaveCount(20)
  await expect(reading).toHaveValue('0:19')
  for (const [char, bitmap] of automatic) {
    await expect(lastGlyph(char)).toHaveAttribute('width', '32')
    expect(await lastGlyph(char).evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(bitmap)
  }
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('保留其他修改')
  for (const [index, [time, value]] of ([[11, '0:09'], [12, '0:08'], [2, '0:18'], [1, '0:19']] as const).entries()) {
    if (index === 0) {
      await page.locator('.editor-stage').focus()
      await page.keyboard.press('Control+z')
    } else await page.getByRole('button', { name: '撤回自动写入' }).click()
    await expect(reading).toHaveValue(value)
    await expect(page.locator('.template-thumb')).toHaveCount(16 - index * 4)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(time, 2)
  }
  await expect(page.getByRole('button', { name: '撤回自动写入' })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('保留其他修改')
  for (const char of ['0', ':', '1', '9']) {
    await expect(page.locator('.template-cell').filter({ has: page.locator('.template-char', { hasText: new RegExp(`^${char}$`) }) })
      .locator('.template-thumb')).toHaveCount(1)
  }
})

test('二值化和字符可用键盘收起, 展开后保留参数和倒计时基准', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(electronApp, page, fixture)
  const video = page.locator('video.editor-media')
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)
  for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) {
    await page.locator('.roi-field input').nth(index).fill(String(value))
  }
  await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1 })
  await expect(page.locator('.glyph-box')).toHaveCount(4)
  const binary = page.locator('details.rail-collapsible').filter({ has: page.getByRole('heading', { name: '二值化', exact: true }) })
  const glyphs = page.locator('details.rail-collapsible').filter({ has: page.getByRole('heading', { name: '字符', exact: true }) })
  const threshold = page.getByRole('slider', { name: '阈值', exact: true })
  await threshold.press('ArrowLeft')
  await binary.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(binary).not.toHaveAttribute('open', '')
  await expect(threshold).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(threshold).toHaveValue('149')
  const reading = page.getByRole('textbox', { name: '整帧读数' })
  await reading.fill('0:19')
  await glyphs.locator('summary').click()
  await expect(reading).toBeHidden()
  await page.getByRole('button', { name: '+1s', exact: true }).click()
  await expect(glyphs.locator('summary')).toContainText('4 个样本')
  await glyphs.locator('summary').click()
  await expect(reading).toHaveValue('0:18')
  await expect(page.getByRole('button', { name: '撤回自动写入' })).toBeEnabled()
  await page.getByRole('button', { name: '撤回自动写入' }).click()
  await expect(reading).toHaveValue('0:19')
  await expect(page.locator('.template-thumb')).toHaveCount(0)
})
