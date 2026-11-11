/** One official crop drives both resolutions, with stable real-frame diagnostics and bounded discovery. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { expect, test } from './electron'
import { loadSource, openPlayer, revealOverlay, seekBoth, setPlaying, waitForBothReady } from './helpers'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const productionSearchRoi = JSON.parse(readFileSync(path.join(root, 'src', 'recognition', 'basicSearchRegion.json'), 'utf8')).roi
const real = !!process.env.STREAM_SYNC_SHARED_OFFICIAL
const exact = real ? { x: .478, y: .042, w: .04, h: .034 } : { x: .42, y: .045, w: .16, h: .13 }
let fixtureRoot = '', commentaryFile = ''

test.beforeAll(async () => {
  const dataRoot = path.join(root, 'e2e', '.data')
  await mkdir(dataRoot, { recursive: true })
  fixtureRoot = await mkdtemp(path.join(dataRoot, 'basic-shared-'))
  commentaryFile = path.join(fixtureRoot, 'commentary-1080.mp4')
  const input = process.env.STREAM_SYNC_SHARED_OFFICIAL || path.join(root, 'public', 'test-sources', 'auto-commentary.mp4')
  await run(process.env.STREAM_SYNC_FIXTURE_FFMPEG || process.env.STREAM_SYNC_FFMPEG || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-i', input, '-t', '40', '-vf', 'scale=1920:1080', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', commentaryFile],
    { windowsHide: true, timeout: 60_000 })
})
test.afterAll(async () => {
  if (fixtureRoot && path.dirname(path.resolve(fixtureRoot)) === path.join(root, 'e2e', '.data')) await rm(fixtureRoot, { recursive: true, force: true })
})

async function chooseFile(page: Page, role: 'official' | 'commentary', file: string): Promise<void> {
  await revealOverlay(page)
  await page.locator('.chip[data-role="' + role + '"]').click()
  const dialog = page.getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
  await dialog.locator('input[type="file"]').setInputFiles(file)
  await expect(dialog).toBeHidden()
}
async function frame(page: Page, roi: typeof exact) {
  await page.getByRole('button', { name: '框选倒计时', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '倒计时范围 (两路共用)', exact: true })
  const canvas = dialog.getByLabel('官方画面当前帧')
  await expect(canvas).toHaveJSProperty('width', real ? 3840 : 1280)
  await dialog.getByRole('button', { name: '重新绘制', exact: true }).click()
  await expect(dialog.locator('.editor-stage')).not.toHaveClass(/is-zoomed/)
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * roi.x, bounds!.y + bounds!.height * roi.y)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width * (roi.x + roi.w), bounds!.y + bounds!.height * (roi.y + roi.h), { steps: 8 })
  await page.mouse.up()
  {
    const original = await dialog.getByLabel('画面缩放').innerText()
    await dialog.getByRole('button', { name: '放大到当前框', exact: true }).click()
    await expect(dialog.locator('.editor-stage')).toHaveClass(/is-zoomed/)
    await expect(dialog.getByLabel('画面缩放')).not.toHaveText(original)
    await page.screenshot({ path: test.info().outputPath('shared-manual-zoom.png') })
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(dialog.locator('.editor-stage')).not.toHaveClass(/is-zoomed/)
  }
  await dialog.getByRole('button', { name: '使用此范围', exact: true }).click()
  await expect(dialog).toBeHidden()
}

test('官方画面一次精确框选应用不同分辨率两路, 图像稳定且产生真实跳秒, 寻找区间仅使用生产配置', async ({ page }) => {
  test.setTimeout(150_000)
  await page.addInitScript(() => {
    const state = window as any
    const stored = JSON.parse(localStorage.getItem('stream-sync.settings.v1') || '{}')
    localStorage.setItem('stream-sync.settings.v1', JSON.stringify({ ...stored, basicClockSearchRoi: { x: 0, y: .8, w: 1, h: .1 } }))
    state.sharedClock = { configurations: [], results: [], errors: [], swaps: [] }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker
      if (String(args[0]).includes('recognition.worker')) {
        worker.addEventListener('error', event => state.sharedClock.errors.push(event.message))
        worker.addEventListener('message', event => {
          const data = event.data
          if (data.type === 'error') state.sharedClock.errors.push(data.message)
          if (data.type === 'result') state.sharedClock.results.push({ role: data.role, basic: data.basic ? { ...data.basic, preview: undefined } : null, outcome: data.outcome, tickMoment: data.tickMoment })
        })
        const post = worker.postMessage.bind(worker)
        worker.postMessage = ((message: any, transfer?: Transferable[]) => {
          if (message.type === 'configure') state.sharedClock.configurations.push(message.profile)
          post(message, transfer ?? [])
        }) as Worker['postMessage']
      }
      return worker
    } })
  })
  await openPlayer(page)
  expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).clockSearchAuthor)).toBe('undefined')
  if (real) await chooseFile(page, 'official', process.env.STREAM_SYNC_SHARED_OFFICIAL!)
  else await loadSource(page, 'official', '/test-sources/auto-official.mp4')
  await chooseFile(page, 'commentary', commentaryFile)
  await waitForBothReady(page)
  await setPlaying(page, false)
  await seekBoth(page, real ? 10 : 8, real ? 5 : 8)
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')].every(video => !video.seeking && video.readyState >= 2))
  const sizes = await page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')].map(video => ({ role: video.dataset.role, width: video.videoWidth, height: video.videoHeight })))
  expect(sizes.find(video => video.role === 'official')!.width).toBe(real ? 3840 : 1280)
  expect(sizes.find(video => video.role === 'commentary')!.width).toBe(1920)
  const panel = page.getByRole('region', { name: '基础识别', exact: true })
  await expect(panel.getByRole('button', { name: '设置寻找区间', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '恢复全画面寻找', exact: true })).toHaveCount(0)
  expect(await panel.getByRole('button', { name: '框选倒计时', exact: true }).count()).toBe(1)
  await frame(page, exact)
  for (const label of ['官方画面基础识别', '国内解说基础识别']) await expect(page.getByRole('article', { name: label })).toContainText('手动范围')
  await setPlaying(page, true)
  await page.keyboard.press('a')
  await expect(page.locator('.align-main.is-running')).toHaveCount(1)
  const official = page.getByRole('article', { name: '官方画面基础识别' })
  await expect(official.getByLabel('官方画面二值化结果')).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => {
    const state = window as any
    const card = document.querySelector('.basic-recognition__card[data-role="official"]')!
    state.sharedObserver = new MutationObserver(() => state.sharedClock.swaps.push({ canvases: card.querySelectorAll('canvas').length,
      fullFrame: [...card.querySelectorAll('canvas')].some(canvas => canvas.getAttribute('aria-label')?.includes('寻找预览')) }))
    state.sharedObserver.observe(card, { childList: true, subtree: true })
  })
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.toast').getByText('已自动对齐', { exact: true })).toBeVisible()
  await expect(official.locator('.basic-recognition__counts')).toContainText(/跳秒 [1-9]/)
  const manual = await page.evaluate(() => { (window as any).sharedObserver.disconnect(); return (window as any).sharedClock })
  expect(manual.errors).toEqual([])
  expect(manual.swaps.every((value: { canvases: number; fullFrame: boolean }) => value.canvases === 1 && !value.fullFrame)).toBe(true)
  expect(manual.configurations).toHaveLength(2)
  for (const profile of manual.configurations) for (const key of ['x', 'y', 'w', 'h']) expect(profile.roi[key]).toBeCloseTo(exact[key as keyof typeof exact], 4)
  for (const role of ['official', 'commentary']) {
    expect(manual.results.some((value: any) => value.role === role && value.outcome.status === 'success')).toBe(true)
    expect(manual.results.some((value: any) => value.role === role && value.tickMoment)).toBe(true)
  }
  await page.screenshot({ path: test.info().outputPath('shared-manual-success.png') })
  await setPlaying(page, false)
  await panel.getByRole('button', { name: '自动重新寻找', exact: true }).click()
  await page.evaluate(() => { (window as any).sharedClock = { configurations: [], results: [], errors: [], swaps: [] } })
  await setPlaying(page, true)
  await page.keyboard.press('a')
  await expect(page.locator('.align-main.is-running')).toHaveCount(1)
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.toast').getByText('已自动对齐', { exact: true })).toBeVisible()
  const bounded = await page.evaluate(() => (window as any).sharedClock)
  expect(bounded.errors).toEqual([])
  expect(bounded.configurations).toHaveLength(2)
  for (const profile of bounded.configurations) {
    expect(profile.roi).toBeUndefined()
    expect(profile.searchRoi ?? null).toEqual(productionSearchRoi)
  }
  await test.info().attach('shared-clock-regression', { body: JSON.stringify({ sizes, manual, bounded }), contentType: 'application/json' })
  await page.screenshot({ path: test.info().outputPath('bounded-search-success.png') })
})
