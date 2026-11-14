import { launchApplication, expect, test } from './electron'
import { CAMERA_STORAGE_KEY, type CameraConfig } from '../src/app/camera'
import { fixturesReady, FIXTURES, loadSource, openCameraFraming, openPlayer } from './helpers'
import type { Page } from '@playwright/test'

const firstKey = `test:${FIXTURES.commentary}`
const secondKey = `test:${FIXTURES.official}`
const read = async (page: Page): Promise<Record<string, CameraConfig>> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), CAMERA_STORAGE_KEY)

test('分别缓存摄像头裁剪和位置, 切换片源及重启后自动恢复', async () => {
  test.skip(!fixturesReady(), '缺少合成视频测试素材')
  const running = await launchApplication('camera-room-memory')
  try {
    await openPlayer(running.page)
    await loadSource(running.page, 'commentary', FIXTURES.commentary)
    const frameA = await openCameraFraming(running.page)
    await expect(frameA.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await frameA.getByRole('button', { name: '保存', exact: true }).click()
    let overlay = running.page.locator('.camera-overlay')
    await expect(overlay).toBeVisible()
    await overlay.focus()
    await running.page.keyboard.press('Shift+ArrowRight')
    await running.page.keyboard.press('Shift+ArrowDown')
    const resize = (await overlay.locator('.camera-resize').boundingBox())!
    await running.page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2)
    await running.page.mouse.down()
    await running.page.mouse.move(resize.x + 80, resize.y + 15, { steps: 5 })
    await running.page.mouse.up()
    const first = (await read(running.page))[firstKey]!
    const firstBox = (await overlay.boundingBox())!
    expect(first.window.x).toBeGreaterThan(0.02)
    expect(first.window.width).toBeGreaterThan(0.22)

    await loadSource(running.page, 'commentary', FIXTURES.official)
    await expect(overlay).toHaveCount(0)
    const frameB = await openCameraFraming(running.page)
    await expect(frameB.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await frameB.locator('.roi-window').focus()
    await running.page.keyboard.press('Shift+ArrowRight')
    await running.page.keyboard.press('Alt+Shift+ArrowDown')
    await frameB.getByRole('button', { name: '保存', exact: true }).click()
    await expect(overlay).toBeVisible()
    await overlay.focus()
    await running.page.keyboard.press('Shift+ArrowDown')
    await running.page.keyboard.press('Shift+ArrowDown')
    const second = (await read(running.page))[secondKey]!
    expect(second.crop).not.toEqual(first.crop)
    expect(second.window).not.toEqual(first.window)
    expect((await read(running.page))[firstKey]).toEqual(first)

    await loadSource(running.page, 'commentary', FIXTURES.commentary)
    await expect(overlay).toBeVisible()
    const restoredA = (await overlay.boundingBox())!
    expect(Math.abs(restoredA.x - firstBox.x)).toBeLessThan(3)
    expect(Math.abs(restoredA.y - firstBox.y)).toBeLessThan(3)
    expect(Math.abs(restoredA.width - firstBox.width)).toBeLessThan(3)
    await running.restart()
    await openPlayer(running.page)
    await loadSource(running.page, 'commentary', FIXTURES.commentary)
    overlay = running.page.locator('.camera-overlay')
    await expect(overlay).toBeVisible()
    const afterRestart = (await overlay.boundingBox())!
    expect(Math.abs(afterRestart.x - firstBox.x)).toBeLessThan(3)
    expect(Math.abs(afterRestart.y - firstBox.y)).toBeLessThan(3)
    expect(Math.abs(afterRestart.width - firstBox.width)).toBeLessThan(3)
    expect((await read(running.page))[firstKey]).toEqual(first)
    // Verify that the crop is actively drawn after automatic restoration.
    await expect.poll(() => overlay.locator('canvas').first().evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      return pixels.some((value, index) => index % 4 !== 3 && value > 30)
    })).toBe(true)
    await loadSource(running.page, 'commentary', FIXTURES.official)
    await expect(overlay).toBeVisible()
    expect((await read(running.page))[secondKey]).toEqual(second)
    expect(await running.page.getByRole('dialog', { name: '摄像头小窗', exact: true }).count()).toBe(0)
  } finally { await running.close() }
})
