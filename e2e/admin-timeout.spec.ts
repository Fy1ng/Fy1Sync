/** Each team timeout has its own native region; either positive cue pauses the HUD. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HudStylePack } from '../src/core/hudStylePack'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError } from './helpers'

test('左右 Timeout 独立取样与开关, 任意侧出现即暂停, 导出重开保留两侧模板', async ({ page, electronApp }, testInfo) => {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  const pictures = await page.evaluate(() => {
    const image = (left: boolean, right: boolean) => {
      const canvas = document.createElement('canvas')
      canvas.width = 320; canvas.height = 180
      const context = canvas.getContext('2d')!
      context.fillStyle = '#000'; context.fillRect(0, 0, 320, 180)
      if (left) {
        context.fillStyle = '#fff'
        context.fillRect(48, 26, 24, 28); context.fillRect(84, 26, 28, 8); context.fillRect(84, 46, 28, 8)
      }
      if (right) {
        context.fillStyle = '#c8c800'
        context.fillRect(180, 26, 24, 28); context.fillRect(220, 26, 28, 8); context.fillRect(240, 34, 8, 20)
      }
      return canvas.toDataURL('image/png').split(',')[1]!
    }
    return { both: image(true, true), left: image(true, false), right: image(false, true) }
  })
  const openImage = async (side: keyof typeof pictures) => {
    await page.locator('main input[accept^="image/"]').setInputFiles({ name: `${side}-timeout.png`, mimeType: 'image/png',
      buffer: Buffer.from(pictures[side], 'base64') })
    await expect(page.locator('img.editor-media')).toBeVisible()
  }
  await openImage('both')
  const target = page.getByRole('combobox', { name: '当前字段', exact: true })
  const toggle = page.getByRole('switch', { name: /^启用当前字段/ })
  for (const [id, x] of [['timeout', 40], ['timeoutRight', 160]] as const) {
    await target.selectOption(id)
    for (const [index, value] of [x / 320, 20 / 180, 120 / 320, 40 / 180].entries()) {
      await page.locator('.roi-fields input').nth(index).fill(String(value))
    }
    if (id === 'timeoutRight') {
      for (let index = 0; index < 50; index++) await page.getByRole('slider', { name: '阈值', exact: true }).press('ArrowLeft')
    }
    await page.getByRole('button', { name: '存为模板', exact: true }).click()
    await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
    await expect(page.getByTestId('hud-phase')).toHaveText('暂停')
  }
  await expect(page.getByTestId('hud-timeout-side')).toHaveText('左右两侧')
  await openImage('left')
  await expect(page.getByTestId('hud-timeout-side')).toHaveText('左侧队伍')
  await expect(page.locator('.cue-result')).toContainText('不出现')
  await target.selectOption('timeout')
  await expect(page.getByRole('slider', { name: '阈值', exact: true })).toHaveValue('150')
  await toggle.press('Space')
  await expect(page.getByTestId('hud-phase')).toHaveText('未配置')
  await expect(page.getByTestId('hud-timeout-side')).toHaveCount(0)
  await toggle.press('Space')
  await expect(page.getByTestId('hud-phase')).toHaveText('暂停')
  await openImage('right')
  await expect(page.getByTestId('hud-timeout-side')).toHaveText('右侧队伍')
  await target.selectOption('timeoutRight')
  await expect(page.getByRole('slider', { name: '阈值', exact: true })).toHaveValue('100')
  await toggle.press('Space')
  await expect(page.getByTestId('hud-phase')).toHaveText('未配置')
  await toggle.press('Space')
  await expect(page.getByTestId('hud-timeout-side')).toHaveText('右侧队伍')

  const file = testInfo.outputPath('team-timeouts.json')
  await mkdir(dirname(file), { recursive: true })
  await electronApp.evaluate(({ session }, file) => {
    const state = globalThis as typeof globalThis & { __timeoutDownload?: Promise<string> }
    state.__timeoutDownload = new Promise(resolve => session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(file)
      item.once('done', (_done, status) => resolve(status))
    }))
  }, file)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __timeoutDownload: Promise<string> }).__timeoutDownload)).toBe('completed')
  const pack = JSON.parse(await readFile(file, 'utf8')) as HudStylePack
  const cues = pack.variants[0]!.cues
  expect(cues.timeout!.roi.x).toBe(40)
  expect(cues.timeoutRight!.roi.x).toBe(160)
  expect(cues.timeout!.templates).toHaveLength(1)
  expect(cues.timeoutRight!.templates).toHaveLength(1)
  expect(cues.timeout!.templates[0]).not.toBe(cues.timeoutRight!.templates[0])
  expect(pack.variants[0]!.states.paused).toBeUndefined()
  await page.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('button', { name: '新建空白样式', exact: true }).click()
  await page.getByLabel('导入 JSON', { exact: true }).setInputFiles(file)
  await expect(page.getByRole('status', { name: '编辑器提示' })).toContainText('已导入')
  await target.selectOption('timeoutRight')
  await expect(page.locator('.cue-result')).toHaveText('出现 / 得分 1.000')
  await expect(page.getByTestId('hud-timeout-side')).toHaveText('右侧队伍')
  await expect(page.getByTestId('hud-phase')).toHaveText('暂停')
  await page.screenshot({ path: testInfo.outputPath('right-team-timeout.png'), fullPage: true })
})
