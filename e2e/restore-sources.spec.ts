import { launchApplication, expect, test } from './electron'
import { LAST_SOURCES_STORAGE_KEY } from '../src/app/lastSources'
import { fixturesReady, FIXTURES, loadBothFixtures, loadSource, openCameraFraming, openPlayer, waitForBothReady } from './helpers'

test('重启后点击恢复上次载入画面和解说, 同时还原摄像头位置', async () => {
  test.skip(!fixturesReady(), '缺少合成视频测试素材')
  const running = await launchApplication('restore-last-sources')
  try {
    await openPlayer(running.page)
    await loadBothFixtures(running.page)
    await expect.poll(() => running.page.evaluate(key => {
      const history = JSON.parse(localStorage.getItem(key) ?? '{}')
      return [history.sources?.official?.input, history.sources?.commentary?.input]
    }, LAST_SOURCES_STORAGE_KEY)).toEqual([FIXTURES.official, FIXTURES.commentary])
    const framing = await openCameraFraming(running.page)
    await expect(framing.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await framing.getByRole('button', { name: '保存', exact: true }).click()
    let overlay = running.page.locator('.camera-overlay')
    await expect(overlay).toBeVisible()
    await overlay.focus()
    await running.page.keyboard.press('Shift+ArrowRight')
    await running.page.keyboard.press('Shift+ArrowDown')
    const original = (await overlay.boundingBox())!
    await running.restart()
    const intake = running.page.getByRole('dialog', { name: '添加直播间', exact: true })
    await expect(intake).toBeVisible()
    const restore = intake.getByRole('button', { name: '恢复上次', exact: true })
    await expect(restore).toBeEnabled()
    // Remembering never launches network/media acquisition before the user clicks.
    await expect(running.page.locator('.chip[data-role="official"]')).toHaveAttribute('data-status', 'empty')
    await expect(running.page.locator('.chip[data-role="commentary"]')).toHaveAttribute('data-status', 'empty')
    await restore.click()
    await expect(intake).toBeHidden()
    await waitForBothReady(running.page)
    await expect(running.page.locator('video[data-role="official"]')).toHaveAttribute('src', FIXTURES.official)
    await expect(running.page.locator('video[data-role="commentary"]')).toHaveAttribute('src', FIXTURES.commentary)
    overlay = running.page.locator('.camera-overlay')
    await expect(overlay).toBeVisible()
    const restored = (await overlay.boundingBox())!
    expect(Math.abs(restored.x - original.x)).toBeLessThan(3)
    expect(Math.abs(restored.y - original.y)).toBeLessThan(3)
    expect(Math.abs(restored.width - original.width)).toBeLessThan(3)
  } finally { await running.close() }
})

test('只记住解说时也能一键恢复并进入播放器', async () => {
  test.skip(!fixturesReady(), '缺少合成视频测试素材')
  const running = await launchApplication('restore-commentary-only')
  try {
    await openPlayer(running.page)
    await loadSource(running.page, 'commentary', FIXTURES.commentary)
    await expect.poll(() => running.page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').sources?.commentary?.input,
      LAST_SOURCES_STORAGE_KEY)).toBe(FIXTURES.commentary)
    await running.restart()
    const intake = running.page.getByRole('dialog', { name: '添加直播间', exact: true })
    await intake.getByRole('button', { name: '恢复上次', exact: true }).click()
    await expect(intake).toBeHidden()
    await expect(running.page.locator('.chip[data-role="commentary"]')).toHaveAttribute('data-status', 'ready')
    await expect(running.page.locator('.chip[data-role="official"]')).toHaveAttribute('data-status', 'empty')
  } finally { await running.close() }
})
