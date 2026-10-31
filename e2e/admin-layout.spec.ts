/** Layout edits retain independent native regions in the exported pack. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createEmptyHudStylePack, parseHudStylePack, type HudStylePack } from '../src/core/hudStylePack'
import { packBitmap } from '../src/core/bitmapCodec'
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

test('编辑器从 2160p 生成 1440p, 导出并重新导入独立低档布局', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  const pack = createEmptyHudStylePack('e2e/generated-layout', '低档生成测试', { width: 3840, height: 2160 })
  const original = pack.variants[0]!
  original.fields.clock!.roi = { x: 101, y: 53, w: 11, h: 9 }
  pack.bitmaps.replay = { width: 11, height: 9,
    data: packBitmap(Uint8Array.from({ length: 11 * 9 }, (_, index) => index % 11 < 6 ? 255 : 0)) }
  original.cues.replay = { roi: { x: 101, y: 53, w: 11, h: 9 }, preprocess: { scale: 1.8, threshold: 139, invert: true },
    templates: ['replay'], minScore: 0.91 }
  original.organizer = structuredClone(original.cues.replay)
  await page.goto(APP_ORIGIN + '/admin')
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles({
    name: 'layout-2160.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)),
  })
  await expect(page.locator('.editor-note')).toContainText('已导入')
  const layouts = page.getByRole('combobox', { name: '当前布局', exact: true })
  await expect(layouts).toHaveValue(original.id)
  await page.getByRole('button', { name: '生成 1440p', exact: true }).click()
  await expect(layouts).toHaveValue(`${original.id}-1440`)
  await expect(page.getByRole('button', { name: '生成 1440p', exact: true })).toHaveCount(0)

  const savePath = testInfo.outputPath('generated-1440.json')
  await mkdir(dirname(savePath), { recursive: true })
  await electronApp.evaluate(({ session }, targetPath) => {
    const state = globalThis as typeof globalThis & { __scaledLayoutDownload?: Promise<string> }
    state.__scaledLayoutDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(targetPath)
        item.once('done', (_done, outcome) => resolve(outcome))
      })
    })
  }, savePath)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & {
    __scaledLayoutDownload: Promise<string>
  }).__scaledLayoutDownload)).toBe('completed')
  const exported = JSON.parse(await readFile(savePath, 'utf8')) as HudStylePack
  expect(parseHudStylePack(exported).issues).toEqual([])
  expect(exported.schemaVersion).toBe(1)
  expect(exported.variants).toHaveLength(2)
  expect(exported.variants[0]).toEqual(original)
  expect(exported.bitmaps.replay).toEqual(pack.bitmaps.replay)
  const scaled = exported.variants[1]!
  expect(scaled.id).toBe(`${original.id}-1440`)
  expect(scaled.nativeSize).toEqual({ width: 2560, height: 1440 })
  expect(scaled.fields.clock!.roi).toEqual({ x: 67, y: 35, w: 8, h: 6 })
  expect(scaled.fields.clock!.preprocess).toEqual(original.fields.clock!.preprocess)
  for (const cue of [scaled.cues.replay!, scaled.organizer!]) {
    expect(cue.roi).toEqual({ x: 67, y: 35, w: 8, h: 6 })
    expect(cue.preprocess).toEqual(original.cues.replay!.preprocess)
    expect(cue.templates).toHaveLength(1)
    expect(cue.templates[0]).not.toBe('replay')
    expect(exported.bitmaps[cue.templates[0]!]!).toMatchObject({ width: 8, height: 6 })
  }

  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles(savePath)
  await expect(page.locator('.editor-note')).toContainText('已导入')
  await expect(layouts.locator('option')).toHaveCount(2)
  await layouts.selectOption(scaled.id)
  await expect(layouts).toHaveValue(scaled.id)
})
