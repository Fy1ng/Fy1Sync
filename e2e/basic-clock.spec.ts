/** Real decoded video -> Worker/WASM -> automatic discovery -> measured/applied offset. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Page } from '@playwright/test'
import { expect, test } from './electron'
import {
  invoke, loadSource, mediaTimes, offsetReadout, openAlignOptions, openPlayer,
  revealOverlay, seekBoth, setPlaying, waitForBothReady,
} from './helpers'

const sourceDir = fileURLToPath(new URL('../public/test-sources/', import.meta.url))

async function loadLongClocks(page: Page): Promise<void> {
  await loadSource(page, 'official', '/test-sources/auto-official.mp4')
  await loadSource(page, 'commentary', '/test-sources/auto-commentary.mp4')
  await page.keyboard.press('Escape')
  await waitForBothReady(page)
  await seekBoth(page, 8, 8)
}

async function resultText(page: Page): Promise<string> {
  const options = await openAlignOptions(page)
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 40_000 })
  await expect(options.locator('.menu-meta').last()).toBeVisible()
  return options.locator('.menu-meta').last().innerText()
}

test.describe('基础倒计时自动识别', () => {
  test.skip(!['auto-official.mp4', 'auto-commentary.mp4'].every(name => existsSync(sourceDir + name)), '缺少长倒计时测试源')
  test.setTimeout(120_000)

  test('默认免样式包完成测量和对齐, 并记录实际耗时', async ({ page }) => {
    const backends: string[] = []
    page.on('worker', worker => worker.on('console', message => {
      const match = /\[识别 Worker\] 后端: (\S+)/.exec(message.text())
      if (match) backends.push(match[1]!)
    }))
    await openPlayer(page)
    const options = await openAlignOptions(page)
    await expect(options.getByRole('radio', { name: '基础模式', exact: true })).toBeChecked()
    await expect(options.getByRole('combobox', { name: '倒计时样式' })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('basic-mode.png') })
    await page.keyboard.press('Escape')
    await loadLongClocks(page)
    await setPlaying(page, true)

    const before = await mediaTimes(page)
    const measuredAt = Date.now()
    await (await openAlignOptions(page)).getByRole('button', { name: '仅测量', exact: true }).click()
    const measured = await resultText(page)
    const measurementMs = Date.now() - measuredAt
    expect(measured).toContain('上次测得偏差')
    const estimate = Number(/上次测得偏差\s+([\d.+-]+)/.exec(measured)?.[1])
    expect(Math.abs(estimate - 5), measured).toBeLessThanOrEqual(0.25)
    expect(Math.abs((await mediaTimes(page)).lag - before.lag)).toBeLessThanOrEqual(0.25)
    expect(await offsetReadout(page)).toMatchObject({ requested: 0, applied: 0 })

    await page.keyboard.press('Escape')
    await revealOverlay(page)
    const alignedAt = Date.now()
    await page.getByRole('button', { name: '自动对齐', exact: true }).click()
    const aligned = await resultText(page)
    const alignmentMs = Date.now() - alignedAt
    expect(aligned).toContain('复核误差')
    const divergence = Number(/复核误差\s+([\d.+-]+)/.exec(aligned)?.[1])
    expect(Math.abs(divergence), aligned).toBeLessThanOrEqual(0.35)
    expect(Math.abs((await mediaTimes(page)).lag + 5)).toBeLessThanOrEqual(0.55)
    const presets = await invoke(page, 'listPresets', undefined)
    expect(presets.ok && presets.value.presets).toEqual([])
    expect(new Set(backends)).toEqual(new Set(['wasm']))
    await test.info().attach('basic-clock-timing', {
      body: JSON.stringify({ measurementMs, alignmentMs, estimate, divergence, backends }, null, 2),
      contentType: 'application/json',
    })
  })

  test('暂停时不把静止时钟当作递减证据, 且不会移动播放位置', async ({ page }) => {
    await openPlayer(page)
    await loadLongClocks(page)
    await setPlaying(page, false)
    const before = await mediaTimes(page)
    await (await openAlignOptions(page)).getByRole('button', { name: '仅测量', exact: true }).click()
    const result = await resultText(page)
    expect(result).not.toContain('上次测得偏差')
    expect(await offsetReadout(page)).toMatchObject({ requested: 0, applied: 0 })
    const after = await mediaTimes(page)
    expect(after.official).toBeCloseTo(before.official, 2)
    expect(after.commentary).toBeCloseTo(before.commentary, 2)
  })
})
