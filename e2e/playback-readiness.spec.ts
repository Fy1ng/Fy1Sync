import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError, FIXTURES, fixturesReady, loadSource, revealOverlay, sourceDialog } from './helpers'

test('首路出画面即展示播放器, 两路就绪前自动对齐保持准备中', async ({ page }) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/')
  await expect(sourceDialog(page)).toBeVisible()
  const intake = sourceDialog(page)
  await intake.getByRole('radiogroup', { name: '添加到' }).getByRole('radio', { name: /^解说/ }).click()
  await intake.getByRole('textbox', { name: '直播间链接' }).fill(FIXTURES.commentary)
  await intake.getByRole('textbox', { name: '直播间链接' }).press('Enter')
  await expect(sourceDialog(page)).toBeHidden()
  await expect(page.locator('.theater-main')).toHaveAttribute('data-role', 'commentary')
  await expect.poll(() => page.locator('video[data-role="commentary"]').evaluate((video: HTMLVideoElement) =>
    video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0)).toBe(true)
  await revealOverlay(page)
  await expect(page.getByRole('button', { name: '准备中', exact: true })).toBeDisabled()
  await page.keyboard.press('a')
  await expect(page.getByRole('button', { name: '准备中', exact: true })).toBeDisabled()
  await expect(page.getByText(/^自动对齐适配中:/)).toHaveCount(0)
  await loadSource(page, 'official', FIXTURES.official)
  await revealOverlay(page)
  await expect(page.getByRole('button', { name: '自动对齐', exact: true })).toBeEnabled()
})
