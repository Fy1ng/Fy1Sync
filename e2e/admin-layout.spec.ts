/** Layout edits retain independent native regions in the exported pack. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError } from './helpers'

test('编辑器新建并切换布局, 修改新布局区域后分别导出', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = '#222'
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = '#fff'
    context.fillRect(40, 24, 8, 24)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.locator('main input[accept^="image/"]').setInputFiles({
    name: 'layout-source.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  })
  await expect(page.locator('.editor-note')).toContainText('320×180')
  const layouts = page.getByRole('combobox', { name: '当前布局', exact: true })
  await expect(layouts).toHaveValue('official-top-180')
  for (const [index, value] of [0.1, 0.1, 0.2, 0.2].entries()) await page.locator('.roi-fields input').nth(index).fill(String(value))
  await page.getByRole('button', { name: '新建布局', exact: true }).click()
  await expect(layouts).toHaveValue('layout-1')
  await expect(page.getByTestId('layout-organizer-warning')).toBeVisible()
  await expect(page.getByTestId('hud-player-layout')).toHaveText('无法判断: 没有布局匹配')
  await expect(page.locator('.roi-fields input').nth(1)).toHaveValue('0.1000')
  await page.locator('.roi-fields input').nth(1).fill('0.7')
  await page.getByRole('textbox', { name: '布局 ID', exact: true }).fill('bottom-180')
  await page.getByRole('button', { name: '改名', exact: true }).click()
  await expect(layouts).toHaveValue('bottom-180')
  await layouts.selectOption('official-top-180')
  await expect(page.locator('.roi-fields input').nth(1)).toHaveValue('0.1000')
  await layouts.selectOption('bottom-180')
  await expect(page.locator('.roi-fields input').nth(1)).toHaveValue('0.7000')

  const savePath = testInfo.outputPath('two-layouts.json')
  await mkdir(dirname(savePath), { recursive: true })
  await electronApp.evaluate(({ session }, targetPath) => {
    const state = globalThis as typeof globalThis & { __layoutDownload?: Promise<string> }
    state.__layoutDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(targetPath)
        item.once('done', (_done, outcome) => resolve(outcome))
      })
    })
  }, savePath)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __layoutDownload: Promise<string> }).__layoutDownload)).toBe('completed')
  const exported = JSON.parse(await readFile(savePath, 'utf8')) as HudStylePack
  expect(exported.variants.map(variant => variant.id)).toEqual(['official-top-180', 'bottom-180'])
  expect(exported.variants[0]!.fields.clock!.roi).toEqual({ x: 32, y: 18, w: 64, h: 36 })
  expect(exported.variants[1]!.fields.clock!.roi).toEqual({ x: 32, y: 126, w: 64, h: 36 })
  expect(exported.variants[1]!.organizer).toBeNull()
  await page.screenshot({ path: testInfo.outputPath('two-layouts.png'), fullPage: true })
})
