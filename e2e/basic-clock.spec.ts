/** Real decoded video -> Worker/WASM -> automatic discovery -> measured/applied offset. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type Page } from '@playwright/test'
import { expect, test } from './electron'
import {
  mediaTimes, offsetReadout, openAlignOptions, openPlayer,
  revealOverlay, seekBoth, setPlaying, waitForBothReady,
} from './helpers'
import { loadRecordingSource } from './recordingSources'

const runFile = promisify(execFile)
const searchConfig = JSON.parse(readFileSync(new URL('../src/recognition/basicSearchRegion.json', import.meta.url), 'utf8')) as {
  configured: boolean; roi: { x: number; y: number; w: number; h: number } | null
}
const searchRoi = searchConfig.roi ?? { x: .4, y: .04, w: .2, h: .14 }
const width = 1920
const height = 1080
// Keep every digit and its discovery padding inside the bundled production search bounds.
const fontSize = Math.floor(Math.min(88, searchRoi.w * width / 2.7, searchRoi.h * height * .7))
const fixtureFfmpeg = process.env.STREAM_SYNC_FIXTURE_FFMPEG?.trim() || process.env.STREAM_SYNC_FFMPEG?.trim() || 'ffmpeg'
const fixtureFont = process.env.STREAM_SYNC_FONT || (process.platform === 'win32' ? 'C:/Windows/Fonts/consola.ttf'
  : process.platform === 'darwin' ? '/System/Library/Fonts/Menlo.ttc' : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf')
const fixtureKey = createHash('sha256').update(JSON.stringify({ revision: 1, searchConfig, width, height, fontSize, fixtureFont })).digest('hex').slice(0, 16)
const sourceDir = fileURLToPath(new URL(`../.runtime-cache/basic-clock-split-verify/fixtures/${fixtureKey}/`, import.meta.url))

async function prepareLongClocks(): Promise<void> {
  if (fontSize < 24) throw new Error('生产搜索区不足以容纳清晰的合成倒计时, 请检查基础 E2E 夹具布局')
  await mkdir(sourceDir, { recursive: true })
  for (const [role, delay] of [['official', 0], ['commentary', 5]] as const) {
    const target = join(sourceDir, `auto-${role}.mp4`)
    if (existsSync(target)) continue
    const temporary = join(sourceDir, `auto-${role}.${process.pid}.tmp.mp4`)
    const clock = `0\\:%{eif\\:max(0,50-floor(t-${delay}))\\:d\\:2}`
    const font = fixtureFont.replace(/\\/gu, '/').replace(/:/gu, '\\:')
    const plate = { x: Math.ceil(searchRoi.x * width), y: Math.ceil(searchRoi.y * height),
      w: Math.floor(searchRoi.w * width), h: Math.floor(searchRoi.h * height) }
    const filters = [
      `drawbox=x=${plate.x}:y=${plate.y}:w=${plate.w}:h=${plate.h}:color=0x0B0E12:t=fill`,
      `drawtext=fontfile='${font}':text='${clock}':fontsize=${fontSize}:fontcolor=0xF2F5F7` +
        `:x=${plate.x}+(${plate.w}-text_w)/2:y=${plate.y}+(${plate.h}-text_h)/2`,
      `drawtext=fontfile='${font}':text='${role} / basic clock':fontsize=28:fontcolor=0x7A8798:x=32:y=200`,
      `drawbox=x='mod(t*220\\,${width})':y=${height - 60}:w=140:h=14:color=0x3D7EFF:t=fill`,
    ].join(',')
    await runFile(fixtureFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=0x141A21:s=${width}x${height}:d=56:r=30`, '-f', 'lavfi', '-i',
      `sine=frequency=${delay ? 320 : 480}:duration=56:sample_rate=48000`, '-vf', filters,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', temporary], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    await rename(temporary, target)
  }
}

async function loadLongClocks(page: Page): Promise<void> {
  for (const role of ['official', 'commentary'] as const) {
    await loadRecordingSource(page, role, join(sourceDir, `auto-${role}.mp4`))
  }
  await page.keyboard.press('Escape')
  await waitForBothReady(page)
  await setPlaying(page, false)
  await seekBoth(page, 8, 8)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .every(video => !video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - 8) < .1)),
  { timeout: 15_000, message: '两路合成视频应完成 seek 和解码准备' }).toBe(true)
}

async function resultText(page: Page): Promise<string> {
  const options = await openAlignOptions(page)
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 40_000 })
  await expect(options.locator('.menu-meta').last()).toBeVisible()
  return options.locator('.menu-meta').last().innerText()
}

test.describe('基础倒计时自动识别', () => {
  test.setTimeout(120_000)
  test.beforeAll(prepareLongClocks)

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
    const afterMeasurement = await mediaTimes(page)
    expect(Math.abs(afterMeasurement.lag - before.lag)).toBeLessThanOrEqual(0.25)
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
    const afterAlignment = await mediaTimes(page)
    expect(Math.abs(afterAlignment.lag + 5)).toBeLessThanOrEqual(0.55)
    expect(new Set(backends)).toEqual(new Set(['wasm']))
    const timingPath = test.info().outputPath('basic-clock-timing.json')
    await writeFile(timingPath, JSON.stringify({ measurementMs, alignmentMs, estimate, divergence, backends,
      before, afterMeasurement, afterAlignment,
      fixture: { sourceDir, searchConfig, width, height, fontSize, delaySeconds: 5 } }, null, 2))
    await test.info().attach('basic-clock-timing', {
      path: timingPath, contentType: 'application/json',
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
    const pausedPath = test.info().outputPath('basic-clock-paused.json')
    await writeFile(pausedPath, JSON.stringify({ result, before, after }, null, 2))
    await test.info().attach('basic-clock-paused', { path: pausedPath, contentType: 'application/json' })
  })
})
