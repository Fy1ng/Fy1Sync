/** Zoom changes only the view; exported regions retain native frame pixels. */
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Locator } from '@playwright/test'
import { createEmptyHudStylePack, parseHudStylePack, type HudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError } from './helpers'

const referenceFrame = 'C:/Users/Fy1ng/Documents/ChatGPT/Fy1Sync/.runtime-cache/codex-stage2-impl2-20261031/frames/frame-01.png'

async function bounds(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!
}

test('4K倒计时放大后手柄独立可拖动, 导出保留原生像素并可复位', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  const consoleErrors: string[] = []
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(APP_ORIGIN + '/admin')
  const pack = createEmptyHudStylePack('e2e/editor-zoom', '4K画面微调', { width: 3840, height: 2160 })
  const variant = pack.variants[0]!
  variant.fields.clock!.roi = { x: 1850, y: 96, w: 116, h: 64 }
  for (const [id, x] of [['scoreLeft', 1720], ['scoreRight', 2040]] as const) {
    variant.fields[id] = { ...structuredClone(variant.fields.clock!), roi: { x, y: 92, w: 64, h: 108 },
      grammar: { kind: 'integer', min: 0, max: 99 } }
  }
  pack.variants.push({ ...structuredClone(variant), id: 'alternate-2160' })
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles({
    name: 'zoom-2160.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)),
  })
  await expect(page.locator('.editor-note')).toContainText('已导入')

  // Keep the repository test portable when the local recording is unavailable.
  const screenshot = existsSync(referenceFrame) ? await readFile(referenceFrame) : Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 3840
    canvas.height = 2160
    const context = canvas.getContext('2d')!
    context.fillStyle = '#182329'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#fff'
    context.font = 'bold 60px sans-serif'
    context.fillText('0:03', 1850, 152)
    return canvas.toDataURL('image/png').split(',')[1]!
  }), 'base64')
  const imageInput = page.locator('main input[accept^="image/"]')
  await imageInput.setInputFiles({ name: 'pgl-4k.png', mimeType: 'image/png', buffer: screenshot })
  await expect(page.locator('.editor-note')).toContainText('3840×2160')
  const media = page.locator('img.editor-media')
  const stage = page.locator('.editor-stage')
  const roi = page.locator('.roi-window:not(.is-readonly)')
  const zoom = page.getByLabel('画面缩放', { exact: true })
  const fit = page.getByRole('button', { name: '适应窗口', exact: true })
  const focus = page.getByRole('button', { name: '放大到当前框', exact: true })
  await expect(media).toBeVisible()
  const fitted = await bounds(media)
  const fittedZoom = await zoom.innerText()
  await page.screenshot({ path: testInfo.outputPath('01-fit.png'), fullPage: true })

  // A wheel zoom keeps the image fraction under the cursor fixed.
  const viewport = await bounds(stage)
  const anchor = { x: viewport.x + viewport.width * 0.6, y: viewport.y + viewport.height * 0.6 }
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.wheel(0, -240)
  await expect.poll(async () => (await bounds(media)).width).toBeGreaterThan(fitted.width)
  const wheeled = await bounds(media)
  expect((anchor.x - wheeled.x) / wheeled.width).toBeCloseTo((anchor.x - fitted.x) / fitted.width, 3)
  expect((anchor.y - wheeled.y) / wheeled.height).toBeCloseTo((anchor.y - fitted.y) / fitted.height, 3)

  // Middle-button drag pans without entering an ROI drag.
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(anchor.x + 28, anchor.y + 16, { steps: 4 })
  await page.mouse.up({ button: 'middle' })
  const panned = await bounds(media)
  expect(panned.x - wheeled.x).toBeCloseTo(28, 0)
  expect(panned.y - wheeled.y).toBeCloseTo(16, 0)
  await fit.click()
  await expect(zoom).toHaveText(fittedZoom)
  expect((await bounds(media)).width).toBeCloseTo(fitted.width, 1)

  await focus.click()
  await expect.poll(async () => (await bounds(roi)).width).toBeGreaterThan(300)
  expect(await media.evaluate(node => getComputedStyle(node).imageRendering)).toBe('pixelated')
  const focused = await bounds(media)
  const focusedZoom = await zoom.innerText()
  const handles = roi.locator('.roi-handle')
  expect(await handles.count()).toBe(8)
  const handleBoxes = await Promise.all(Array.from({ length: 8 }, (_, index) => bounds(handles.nth(index))))
  for (const [index, box] of handleBoxes.entries()) {
    expect(box.width).toBeCloseTo(10, 1)
    expect(box.height).toBeCloseTo(10, 1)
    for (const other of handleBoxes.slice(index + 1)) {
      const overlapX = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)
      const overlapY = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)
      expect(overlapX <= 0 || overlapY <= 0).toBe(true)
    }
    expect(await handles.nth(index).evaluate(node => {
      const rect = node.getBoundingClientRect()
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === node
    })).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('02-clock-focus.png'), fullPage: true })

  const southeast = roi.locator('[data-handle="se"]')
  const corner = await bounds(southeast)
  const start = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }
  // Derive the gesture from rendered native scale, independently of the zoom model.
  const scale = focused.width / 3840
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 12 * scale, start.y + 8 * scale, { steps: 6 })
  await page.mouse.up()
  await expect(roi.locator('.roi-size')).toContainText('128×72')
  await roi.focus()
  await roi.press('ArrowRight')
  await roi.press('Shift+ArrowDown')
  await page.screenshot({ path: testInfo.outputPath('03-clock-resized.png'), fullPage: true })
  // The rail's one-pixel buttons: X twice right, then one back, and the width one narrower.
  await page.getByRole('button', { name: 'X加 1 像素', exact: true }).click()
  await page.getByRole('button', { name: 'X加 1 像素', exact: true }).click()
  await page.getByRole('button', { name: 'X减 1 像素', exact: true }).click()
  await page.getByRole('button', { name: '宽减 1 像素', exact: true }).click()
  await expect(roi.locator('.roi-size')).toContainText('127×72')

  const savePath = testInfo.outputPath('zoom-native-coordinates.json')
  await mkdir(dirname(savePath), { recursive: true })
  await electronApp.evaluate(({ session }, targetPath) => {
    const state = globalThis as typeof globalThis & { __zoomDownload?: Promise<string> }
    state.__zoomDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(targetPath)
        item.once('done', (_done, outcome) => resolve(outcome))
      })
    })
  }, savePath)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __zoomDownload: Promise<string> }).__zoomDownload)).toBe('completed')
  const exported = JSON.parse(await readFile(savePath, 'utf8')) as HudStylePack
  expect(parseHudStylePack(exported).issues).toEqual([])
  expect(exported.variants[0]!.fields.clock!.roi).toEqual({ x: 1852, y: 106, w: 127, h: 72 })
  expect(exported.variants[0]!.fields.scoreLeft).toEqual(variant.fields.scoreLeft)
  expect(exported.variants[0]!.fields.scoreRight).toEqual(variant.fields.scoreRight)
  expect(exported.variants[1]).toEqual(pack.variants[1])

  const fields = page.getByRole('combobox', { name: '当前字段', exact: true })
  await fields.selectOption('scoreLeft')
  await expect(zoom).toHaveText(focusedZoom)
  expect(await bounds(media)).toEqual(focused)
  await fields.selectOption('clock')
  // The lower empty part of the stage is safely outside the focused scoreboard.
  await stage.dblclick({ position: { x: viewport.width * 0.75, y: viewport.height * 0.85 } })
  await expect(zoom).toHaveText(fittedZoom)
  await focus.click()
  await page.getByRole('combobox', { name: '当前布局', exact: true }).selectOption('alternate-2160')
  await expect(zoom).toHaveText(fittedZoom)
  await focus.click()
  await imageInput.setInputFiles({ name: 'pgl-4k-next.png', mimeType: 'image/png', buffer: screenshot })
  await expect(zoom).toHaveText(fittedZoom)
  expect(consoleErrors).toEqual([])
})
