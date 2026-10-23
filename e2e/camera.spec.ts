import { expect, test } from './electron'
import { fixturesReady, loadBothFixtures, openPlayer, revealOverlay, seekBoth, setPlaying } from './helpers'
import type { Page } from '@playwright/test'

async function openCamera(page: Page): Promise<void> {
  await revealOverlay(page)
  await page.locator('.overlay-bar').getByRole('button', { name: /^摄像头/ }).click()
  await page.getByRole('option', { name: '框选摄像头…' }).click()
  await expect(page.getByRole('dialog', { name: '摄像头小窗取景' })).toBeVisible()
}

async function picture(page: Page) {
  return page.locator('.camera-dialog-still').evaluate((canvas: HTMLCanvasElement) => {
    const rgba = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let hash = 2166136261
    for (let i = 0; i < rgba.length; i += 16) hash = Math.imul(hash ^ rgba[i]!, 16777619)
    const video = document.querySelector<HTMLVideoElement>('video[data-role=commentary]')!
    return { hash, time: video.currentTime, paused: video.paused, width: canvas.width, height: canvas.height, videos: document.querySelectorAll('video').length }
  })
}

test.describe('摄像头取景实时帧', () => {
  test.skip(!fixturesReady(), '缺少本地测试源')
  test('预览随解说帧推进且暂停和 seek 保持一致', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)
    await openCamera(page)
    const before = await picture(page)
    await expect.poll(async () => (await picture(page)).time).toBeGreaterThan(before.time + 1.1)
    const after = await picture(page)
    expect(after.paused).toBe(false)
    expect(after.videos).toBe(2)
    expect(after.hash).not.toBe(before.hash)
    await page.evaluate(() => document.querySelectorAll('video').forEach(video => video.pause()))
    // Let the last decoded frame be painted before checking a paused preview.
    await page.waitForTimeout(150)
    const paused = await picture(page)
    await page.waitForTimeout(350)
    expect((await picture(page)).hash).toBe(paused.hash)
    await seekBoth(page, 10, 10)
    await expect.poll(async () => (await picture(page)).hash).not.toBe(paused.hash)
    expect((await picture(page)).paused).toBe(true)
    const dialog = page.getByRole('dialog', { name: '摄像头小窗取景' })
    await dialog.getByRole('button', { name: '自动收紧', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('暂停')
    await expect(dialog.getByRole('button', { name: '保存并显示' })).toBeEnabled()
    expect((await picture(page)).paused).toBe(true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await openCamera(page)
    expect((await picture(page)).paused).toBe(true)
  })
})
