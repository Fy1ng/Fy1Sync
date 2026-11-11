/** The author-only utility writes a fixed project config once; production has no author API. */
import { _electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClockSearchAuthorApi } from '../scripts/clock-search-authoring/authorStore'
import { visibleE2eWindows } from './electron'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const appMain = path.join(root, '.runtime-cache', 'clock-search-authoring', 'main.cjs')
const productionFile = path.join(root, 'src', 'recognition', 'basicSearchRegion.json')
const fixture = path.join(root, 'public', 'test-sources', 'auto-official.mp4')

test('制作工具仅显式保存时写入, 写后及重启锁定, reset才允许重新制作', async ({}, testInfo) => {
  test.skip(!visibleE2eWindows, '独立制作工具会显式显示并聚焦原生窗口, 尚未支持隐藏测试窗口; 设置 STREAM_SYNC_E2E_VISIBLE=1')
  test.setTimeout(90_000)
  const original = await readFile(productionFile, 'utf8')
  const dataRoot = path.join(root, 'e2e', '.data')
  await mkdir(dataRoot, { recursive: true })
  const data = await mkdtemp(path.join(dataRoot, 'clock-search-author-'))
  const config = path.join(data, 'config.json')
  const empty = JSON.stringify({ schemaVersion: 1, configured: false, roi: null })
  await writeFile(config, empty)
  let app: ElectronApplication | null = null
  let launchIndex = 0
  const launch = async (reset = false) => {
    const profile = path.join(data, 'profile-' + launchIndex++)
    await mkdir(profile)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
    Object.assign(env, { STREAM_SYNC_E2E: '1', STREAM_SYNC_E2E_VISIBLE: visibleE2eWindows ? '1' : '0', STREAM_SYNC_AUTHOR_CONFIG_PATH: config, TEMP: data, TMP: data, TMPDIR: data })
    app = await _electron.launch({ args: [appMain, '--project-root=' + root, '--profile-dir=' + profile, ...(reset ? ['--reset'] : [])], cwd: root, env, timeout: 20_000 })
    const page = await app.firstWindow({ timeout: 20_000 })
    page.on('pageerror', error => { throw error })
    await expect(page.getByRole('heading', { name: '基础模式寻找区间' })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    await page.getByLabel('选择样例录像').setInputFiles(fixture)
    await expect(page.getByRole('button', { name: '框选生产寻找区间' })).toBeEnabled()
    expect(await readFile(config, 'utf8')).toBe(empty)
    await page.getByRole('button', { name: '框选生产寻找区间' }).click()
    const dialog = page.getByRole('dialog', { name: '生产自动寻找区间', exact: true })
    await expect(dialog.getByLabel('样例录像当前帧')).toHaveJSProperty('width', 1280)
    await expect(dialog.getByRole('button', { name: '使用此区间', exact: true })).toBeEnabled()
    const captured = await dialog.getByLabel('样例录像当前帧').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let white = 0, maximum = 0
      for (let index = 0; index < pixels.length; index += 4) { maximum = Math.max(maximum, pixels[index]!); if (pixels[index]! > 200) white++ }
      const video = document.querySelector('video')!
      return { white, maximum, alpha: pixels[3], ready: video.readyState,
        presented: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime }
    })
    await testInfo.attach('captured-frame', { body: JSON.stringify(captured), contentType: 'application/json' })
    expect(captured.white, JSON.stringify(captured)).toBeGreaterThan(100)
    await dialog.getByRole('button', { name: '重新绘制', exact: true }).click()
    const box = await dialog.getByLabel('样例录像当前帧').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width * .3, box!.y + box!.height * .02)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * .7, box!.y + box!.height * .25, { steps: 6 })
    await page.mouse.up()
    await dialog.getByRole('button', { name: '放大到当前框' }).click()
    await expect(dialog.locator('.editor-stage')).toHaveClass(/is-zoomed/)
    await page.screenshot({ path: testInfo.outputPath('author-range-zoom.png') })
    await dialog.getByRole('button', { name: '使用此区间' }).click()
    await expect(dialog).toBeHidden()
    expect(await readFile(config, 'utf8')).toBe(empty)
    await expect(page.getByRole('button', { name: '写入生产配置' })).toBeEnabled()
    await page.getByRole('button', { name: '写入生产配置' }).click()
    await expect(page.getByText('已写入生产配置, 下次构建后生效', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '写入生产配置' })).toHaveCount(0)
    const saved = JSON.parse(await readFile(config, 'utf8')) as { configured: boolean; roi: {x:number;y:number;w:number;h:number} }
    expect(saved.configured).toBe(true)
    expect(saved.roi.x).toBeCloseTo(.3, 3)
    expect(saved.roi.y).toBeCloseTo(.02, 3)
    expect(saved.roi.w).toBeCloseTo(.4, 3)
    expect(saved.roi.h).toBeCloseTo(.23, 3)
    const rejected = await page.evaluate(async () => {
      try { await (window as unknown as {clockSearchAuthor:ClockSearchAuthorApi}).clockSearchAuthor.save({ x: 0, y: 0, w: 1, h: 1 }); return false } catch { return true }
    })
    expect(rejected).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('author-range-locked.png') })
    await app!.close(); app = null
    page = await launch()
    await expect(page.getByText('生产寻找区间已固定, 本工具当前只读.', { exact: true })).toBeVisible()
    await expect(page.getByLabel('选择样例录像')).toHaveCount(0)
    const unchanged = await readFile(config, 'utf8')
    await app!.close(); app = null
    page = await launch(true)
    await expect(page.getByLabel('选择样例录像')).toBeEnabled()
    expect(await readFile(config, 'utf8')).toBe(unchanged)
    expect(await readFile(productionFile, 'utf8')).toBe(original)
  } finally {
    await (app as ElectronApplication | null)?.close()
    if (path.dirname(path.resolve(data)) === dataRoot) await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
