/** Color separation and one-shot recommendations in the production editor/WASM path. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError } from './helpers'

test('HSV 从原图取色分离等灰度深红图标与深蓝背景, 导出重开仍可识别', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = 'rgb(0,0,160)'
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = 'rgb(60,0,0)'
    context.fillRect(48, 26, 24, 28)
    context.fillRect(84, 26, 28, 8)
    context.fillRect(84, 46, 28, 8)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('main input[accept^="image/"]').setInputFiles({ name: 'red-blue.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await expect(page.locator('img.editor-media')).toBeVisible()
  const target = page.getByRole('combobox', { name: '当前字段', exact: true })
  await target.selectOption('bomb')
  for (const [index, value] of [40 / 320, 20 / 180, 120 / 320, 40 / 180].entries()) {
    await page.locator('.roi-fields input').nth(index).fill(String(value))
  }
  const binary = page.getByLabel('二值化结果', { exact: true })
  await expect.poll(() => binary.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual([120, 40])
  await page.getByRole('button', { name: '自动推荐阈值', exact: true }).click()
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('差异不足')
  const mode = page.getByRole('combobox', { name: '二值化模式', exact: true })
  await mode.selectOption('hsv')
  await expect(page.getByRole('slider', { name: '阈值', exact: true })).toHaveCount(0)
  const preview = page.getByRole('img', { name: '原图取色', exact: true })
  await expect(preview).toBeVisible()
  // The color picker must preserve native RGB rather than displaying the grayscale crop.
  await expect.poll(() => preview.evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext('2d')!.getImageData(20, 16, 1, 1).data)))
    .toEqual([60, 0, 0, 255])
  await page.getByRole('button', { name: '从原图取色', exact: true }).click()
  const rect = await preview.boundingBox()
  await preview.click({ position: { x: rect!.width * 20 / 120, y: rect!.height * 16 / 40 } })
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('推荐参数并固定')
  await expect(page.getByRole('slider', { name: '色相', exact: true })).toHaveValue('0')
  await page.getByRole('button', { name: '存为模板', exact: true }).click()
  await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
  await expect(page.getByRole('button', { name: '删除炸弹的模板', exact: true })).toHaveCount(1)

  const savePath = testInfo.outputPath('red-icon.json')
  await mkdir(dirname(savePath), { recursive: true })
  await electronApp.evaluate(({ session }, file) => {
    const state = globalThis as typeof globalThis & { __preprocessDownload?: Promise<string> }
    state.__preprocessDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(file)
        item.once('done', (_done, outcome) => resolve(outcome))
      })
    })
  }, savePath)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __preprocessDownload: Promise<string> }).__preprocessDownload)).toBe('completed')
  const pack = JSON.parse(await readFile(savePath, 'utf8')) as HudStylePack
  expect(pack.variants[0]!.cues.bomb!.preprocess).toMatchObject({ mode: 'hsv', invert: false, hsv: { hue: 0, tolerance: 15 } })
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '新建空白样式', exact: true }).click()
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles(savePath)
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('已导入')
  await target.selectOption('bomb')
  await expect(mode).toHaveValue('hsv')
  await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
  await page.screenshot({ path: testInfo.outputPath('hsv-red-icon.png'), fullPage: true })
})

test('自动判断暗字反相, 自适应阈值可制字并保留独立参数', async ({ page }, testInfo) => {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320; canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = '#eeeeee'; context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#111111'
    const glyph = ['01110', '11011', '11011', '01110', '11011', '11011', '11011', '01110']
    glyph.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel === '1') context.fillRect(100 + x * 6, 40 + y * 6, 6, 6) }))
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('main input[accept^="image/"]').setInputFiles({ name: 'dark-score.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  await expect(page.locator('img.editor-media')).toBeVisible()
  await page.getByRole('combobox', { name: '当前字段', exact: true }).selectOption('scoreLeft')
  for (const [index, value] of [85 / 320, 25 / 180, 60 / 320, 80 / 180].entries()) {
    await page.locator('.roi-fields input').nth(index).fill(String(value))
  }
  await page.getByRole('button', { name: '自动判断反相', exact: true }).click()
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('推荐参数并固定')
  await expect(page.getByRole('switch', { name: /反相/ })).toBeChecked()
  await expect(page.locator('.glyph-box')).toHaveCount(1)
  await page.getByRole('combobox', { name: '二值化模式', exact: true }).selectOption('adaptive')
  await page.getByRole('spinbutton', { name: '局部窗口大小', exact: true }).fill('51')
  await expect(page.locator('.glyph-box')).toHaveCount(1)
  await page.locator('.char-pad').getByRole('button', { name: '8', exact: true }).click()
  await expect(page.locator('.template-thumb')).toHaveCount(1)
  await page.getByRole('button', { name: '验证当前帧', exact: true }).click()
  await expect(page.locator('.verify-result')).toContainText('识别为 8')
  await page.getByRole('combobox', { name: '当前字段', exact: true }).selectOption('scoreRight')
  await expect(page.getByRole('combobox', { name: '二值化模式', exact: true })).toHaveValue('gray')
  await expect(page.getByRole('switch', { name: /反相/ })).not.toBeChecked()
  await page.getByRole('combobox', { name: '当前字段', exact: true }).selectOption('scoreLeft')
  await expect(page.getByRole('combobox', { name: '二值化模式', exact: true })).toHaveValue('adaptive')
  await expect(page.getByRole('spinbutton', { name: '局部窗口大小', exact: true })).toHaveValue('51')
  await expect(page.getByRole('switch', { name: /反相/ })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('adaptive-dark-score.png'), fullPage: true })
})
