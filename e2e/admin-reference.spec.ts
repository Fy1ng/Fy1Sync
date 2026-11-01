/** A package's reference pixels do not restrict the actual footage, and colons retain their own evidence. */
import { createEmptyHudStylePack, parseHudStylePack } from '../src/core/hudStylePack'
import { createHudPreprocess } from '../src/core/hudPreprocess'
import { normalizeGlyph } from '../src/core/imageOps'
import { packBitmap } from '../src/core/bitmapCodec'
import { CLOCK_CHARS } from '../src/core/profileSchema'
import { createFrame, drawText, renderGlyphMask } from '../src/test/glyphFont'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError, invoke } from './helpers'

test('跨分辨率制样和验证共用参考区域, 冒号低分不拉低数字总分', async ({ page }, testInfo) => {
  failOnPageError(page)
  const frame = createFrame(640, 360)
  drawText(frame, '1:37', 240, 32, { scale: 8 })
  for (let y = 204; y < 212; y++) for (let x = 524; x < 532; x++) frame.data.set([245, 245, 245, 255], (y * 640 + x) * 4)
  const pack = createEmptyHudStylePack('test/resolution', '跨分辨率验收', { width: 640, height: 360 })
  const variant = pack.variants[0]!, clock = variant.fields.clock!
  clock.roi = { x: 232, y: 24, w: 208, h: 72 }
  clock.preprocess = createHudPreprocess({ scale: 1, threshold: 120 })
  clock.match.minScore = 0.75
  for (const char of CLOCK_CHARS) {
    const id = char === ':' ? 'colon' : `digit-${char}`
    const mask = normalizeGlyph(renderGlyphMask(char, 8))
    if (char === ':') {
      let ink = 0
      for (let index = 0; index < mask.length; index++) if (mask[index] && ++ink % 7 === 0) mask[index] = 0
    }
    pack.bitmaps[id] = { width: 32, height: 48, data: packBitmap(mask) }
    clock.glyphs[char] = [id]
  }
  pack.bitmaps.timeout = { width: 16, height: 16, data: packBitmap(Uint8Array.from({ length: 256 }, (_, index) =>
    index % 16 >= 4 && index % 16 < 12 && index >= 64 && index < 192 ? 255 : 0)) }
  variant.cues.timeoutRight = { enabled: true, roi: { x: 520, y: 200, w: 16, h: 16 },
    preprocess: createHudPreprocess({ scale: 1, threshold: 120 }), templates: ['timeout'], minScore: 0.9 }
  expect(parseHudStylePack(pack).issues).toEqual([])
  await page.goto(APP_ORIGIN + '/admin')
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles({ name: 'reference.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) })
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('已导入')
  const pictures = await page.evaluate(raw => {
    const input = document.createElement('canvas')
    input.width = 640; input.height = 360
    const pixels = Uint8ClampedArray.from(atob(raw), char => char.charCodeAt(0))
    input.getContext('2d')!.putImageData(new ImageData(pixels, 640, 360), 0, 0)
    return [2, 0.5].map(scale => {
      const canvas = document.createElement('canvas')
      canvas.width = 640 * scale; canvas.height = 360 * scale
      const context = canvas.getContext('2d')!
      context.imageSmoothingEnabled = false
      context.drawImage(input, 0, 0, canvas.width, canvas.height)
      return { width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png').split(',')[1]! }
    })
  }, Buffer.from(frame.data).toString('base64'))
  for (const picture of pictures) {
    await page.locator('main input[accept^="image/"]').setInputFiles({ name: `scaled-${picture.width}.png`, mimeType: 'image/png', buffer: Buffer.from(picture.png, 'base64') })
    await expect(page.getByTestId('layout-scaled-frame')).toContainText(`${picture.width}x${picture.height}`)
    await expect(page.locator('.glyph-box')).toHaveCount(4)
    await page.getByRole('button', { name: '验证当前帧', exact: true }).click()
    await expect(page.locator('.verify-result')).toContainText('识别为 1:37')
    const matches = await page.locator('.match-list li').evaluateAll(rows => rows.map(row => ({
      char: row.querySelector('b')!.textContent, score: Number(row.children[1]!.textContent),
    })))
    const colon = matches.find(match => match.char === ':')!
    const confidence = Math.min(...matches.filter(match => match.char !== ':').map(match => match.score))
    expect(colon.score).toBeLessThan(confidence)
    await expect(page.locator('.verify-result')).toContainText(`置信度 ${confidence.toFixed(3)}`)
    await expect(page.getByTestId('hud-player-layout')).toHaveText(variant.id)
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    expect(saved.ok && saved.value.project?.pack).toEqual(pack)
  }
  await page.getByRole('combobox', { name: '当前字段', exact: true }).selectOption('timeoutRight')
  await expect(page.locator('.cue-result')).toContainText('出现')
  await page.getByRole('button', { name: '存为模板', exact: true }).click()
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('存为模板')
  await expect.poll(async () => {
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    return saved.ok && saved.value.project ? saved.value.project.pack.variants[0]!.cues.timeoutRight!.templates.length : -1
  }).toBe(2)
  const saved = await invoke(page, 'editorProjectLoad', undefined)
  if (!saved.ok || !saved.value.project) throw new Error('Expected saved reference layout')
  const updated = saved.value.project.pack
  const cue = updated.variants[0]!.cues.timeoutRight!
  expect(updated.variants[0]!.nativeSize).toEqual({ width: 640, height: 360 })
  expect(updated.bitmaps[cue.templates[1]!]).toMatchObject({ width: 16, height: 16 })
  expect(parseHudStylePack(updated).issues).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('cross-resolution-cue.png') })
})
