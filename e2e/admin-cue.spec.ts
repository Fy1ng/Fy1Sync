/** Whole-region cue teaching uses the same Rust entry as the current-frame preview. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError } from './helpers'

test('编辑器存下整块回放模板, 当前帧出现且导入后仍匹配', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = '#000'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fff'
    // Asymmetric integer blocks give the cue foreground and background without font variance.
    context.fillRect(48, 26, 24, 28)
    context.fillRect(84, 26, 28, 8)
    context.fillRect(84, 46, 28, 8)
    context.fillRect(126, 32, 22, 16)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('main input[accept^="image/"]').setInputFiles({
    name: 'replay-blocks.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  })
  await expect(page.locator('img.editor-media')).toBeVisible()
  await expect(page.locator('.editor-note')).toContainText('320×180')
  await page.getByRole('textbox', { name: '标识', exact: true }).fill('e2e/cue-template')
  const target = page.getByRole('combobox', { name: '当前字段', exact: true })
  await target.selectOption('replay')
  // Empty crops cannot become bitmaps that the pack's existing validator would reject.
  for (const [index, value] of [0, 0, 8 / 320, 8 / 180].entries()) {
    await page.locator('.roi-fields input').nth(index).fill(String(value))
  }
  await expect.poll(() => page.getByLabel('二值化结果', { exact: true }).evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([8, 8])
  await page.getByRole('button', { name: '存为模板', exact: true }).click()
  await expect(page.locator('.editor-note.is-error')).toContainText('位图不能全空或全满')
  await expect(page.getByRole('button', { name: '删除回放标记的模板', exact: true })).toHaveCount(0)
  for (const [index, value] of [40 / 320, 20 / 180, 120 / 320, 40 / 180].entries()) {
    await page.locator('.roi-fields input').nth(index).fill(String(value))
  }
  const binary = page.getByLabel('二值化结果', { exact: true })
  await expect.poll(() => binary.evaluate((node: HTMLCanvasElement) => [node.width, node.height])).toEqual([120, 40])
  await expect(page.locator('.glyph-box')).toHaveCount(0)
  await expect(page.locator('.cue-result')).toContainText('识别失败')
  await page.getByRole('button', { name: '存为模板', exact: true }).click()
  await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
  await expect(page.getByRole('button', { name: '删除回放标记的模板', exact: true })).toHaveCount(1)

  const savePath = testInfo.outputPath('cue-template.json')
  await mkdir(dirname(savePath), { recursive: true })
  await electronApp.evaluate(({ session }, targetPath) => {
    const state = globalThis as typeof globalThis & { __cuePackDownload?: Promise<string> }
    state.__cuePackDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(targetPath)
        item.once('done', (_done, outcome) => resolve(outcome))
      })
    })
  }, savePath)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & {
    __cuePackDownload: Promise<string>
  }).__cuePackDownload)).toBe('completed')
  const pack = JSON.parse(await readFile(savePath, 'utf8')) as HudStylePack
  const cue = pack.variants[0]!.cues.replay!
  expect(cue.roi).toEqual({ x: 40, y: 20, w: 120, h: 40 })
  expect(cue.templates).toHaveLength(1)
  expect(pack.bitmaps[cue.templates[0]!]!).toMatchObject({ width: 120, height: 40 })

  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '新建空白样式', exact: true }).click()
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles(savePath)
  await expect(page.locator('.editor-note')).toContainText('已导入')
  await target.selectOption('replay')
  await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
  await expect(page.getByRole('button', { name: '删除回放标记的模板', exact: true })).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('cue-template-imported.png'), fullPage: true })
})
