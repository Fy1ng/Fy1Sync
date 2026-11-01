import { expect, test } from './electron'
import { fixturesReady, loadBothFixtures, openCameraFraming, openPlayer, setPlaying } from './helpers'
import { CAMERA_STORAGE_KEY } from '../src/app/camera'

test('彩色小摄像头贴边保留局部原生细节, 分析不阻塞播放且可撤回', async ({ page }, testInfo) => {
  test.skip(!fixturesReady(), 'Run npm run fixtures to prepare isolated playback sources')
  await openPlayer(page)
  await loadBothFixtures(page)
  await setPlaying(page, true)
  const truth = { x: 64, y: 470, w: 176, h: 130, width: 1920, height: 1080 }
  await page.evaluate(async truth => {
    const canvas = document.createElement('canvas')
    canvas.width = truth.width; canvas.height = truth.height
    const ctx = canvas.getContext('2d')!
    let frame = 0
    const draw = () => {
      // The two sides have practically identical luminance, but distinct color edges.
      ctx.fillStyle = 'rgb(181, 48, 75)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = 'rgb(40, 103, 162)'; ctx.fillRect(truth.x, truth.y, truth.w, truth.h)
      ctx.fillStyle = 'rgb(72, 114, 153)'; ctx.fillRect(truth.x + 35 + frame % 30, truth.y + 30, 25, 35)
      frame++
    }
    draw()
    setInterval(draw, 80)
    const video = document.querySelector<HTMLVideoElement>('video[data-role="commentary"]')!
    video.pause()
    video.removeAttribute('src')
    video.srcObject = canvas.captureStream(12)
    await video.play()
  }, truth)
  await expect.poll(() => page.locator('video[data-role="commentary"]').evaluate((node: HTMLVideoElement) => node.videoWidth)).toBe(truth.width)
  const dialog = await openCameraFraming(page)
  const sizeBefore = await dialog.locator('.roi-size').innerText()
  const framesBefore = await page.locator('video[data-role="commentary"]').evaluate((node: HTMLVideoElement) => node.getVideoPlaybackQuality().totalVideoFrames)
  await dialog.getByRole('button', { name: '贴边', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('四条边均已贴合', { timeout: 20_000 })
  const size = (await dialog.locator('.roi-size').innerText()).split('×').map(Number)
  expect(Math.abs(size[0]! - truth.w)).toBeLessThanOrEqual(4)
  expect(Math.abs(size[1]! - truth.h)).toBeLessThanOrEqual(4)
  await dialog.screenshot({ path: testInfo.outputPath('color-camera-fit.png') })
  expect(await page.locator('video[data-role="commentary"]').evaluate((node: HTMLVideoElement) => node.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(framesBefore)
  await dialog.getByRole('button', { name: '撤回贴边', exact: true }).click()
  await expect(dialog.locator('.roi-size')).toHaveText(sizeBefore)
  await dialog.getByRole('button', { name: '贴边', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('四条边均已贴合', { timeout: 20_000 })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.camera-overlay')).toBeVisible()
  const crop = await page.evaluate(key => {
    const values = Object.values(JSON.parse(localStorage.getItem(key) ?? '{}')) as Array<{ crop: { x: number; y: number; w: number; h: number } }>
    return values[0]?.crop
  }, CAMERA_STORAGE_KEY)
  expect(crop).toBeTruthy()
  expect(Math.abs(crop!.x * truth.width - truth.x)).toBeLessThanOrEqual(4)
  expect(Math.abs(crop!.y * truth.height - truth.y)).toBeLessThanOrEqual(4)
})
