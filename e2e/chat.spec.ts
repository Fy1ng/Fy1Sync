/**
 * The sidebar chat list under load: 200 messages a second through the real relay, IPC,
 * timeline and windowing. The point is that the DOM stays bounded while the history grows,
 * and that a reader scrolled up is not moved by arriving messages.
 */

import { expect, test } from './electron'
import { fixturesReady, loadBothFixtures, openPlayer, seekBoth, setPlaying, stressDanmaku } from './helpers'

test.describe('弹幕列表', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('每秒 200 条时列表节点数有上限，往上翻看时不被推走', async ({ page, electronApp }) => {
    const stop = await stressDanmaku(electronApp, 200)
    try {
      await openPlayer(page)
      await loadBothFixtures(page)
      await seekBoth(page, 3, 3)
      await setPlaying(page, true)

      const dialog = page.getByRole('dialog', { name: '片源设置' })
      await page.locator('.stage-top').getByRole('button', { name: '片源设置' }).click()
      const room = dialog.locator('.danmaku-room')
      await room.getByRole('textbox').fill('288016')
      await room.getByRole('button', { name: '连接' }).click()
      await dialog.getByRole('button', { name: '完成' }).click()

      const list = page.locator('.chat-scroller')
      await expect(list.locator('.chat-row').first()).toBeVisible({ timeout: 20_000 })

      // Let the history outgrow the viewport many times over.
      await expect.poll(async () => list.evaluate((node) => node.scrollHeight / node.clientHeight), { timeout: 20_000 })
        .toBeGreaterThan(20)
      const rows = await list.locator('.chat-row').count()
      // A real viewport, or windowing is measuring nothing.
      expect(await list.evaluate((node) => node.clientHeight)).toBeGreaterThan(200)
      // 260px viewport / 26px rows = 10 visible, plus 6 overscan either side.
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThanOrEqual(30)

      // Following the bottom while pinned.
      expect(await list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(30)

      // Scroll up and remember a row; it must stay put as messages keep arriving.
      await list.evaluate((node) => { node.scrollTop = node.scrollHeight / 2 })
      await page.waitForTimeout(300)
      const anchor = list.locator('.chat-row').nth(8)
      const text = await anchor.locator('.chat-text').textContent()
      const before = await page.getByText(text!, { exact: true }).boundingBox()
      await page.waitForTimeout(1500)
      const after = await page.getByText(text!, { exact: true }).boundingBox()
      expect(after).not.toBeNull()
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2)
      expect(await list.locator('.chat-row').count()).toBeLessThanOrEqual(30)

      const jump = page.locator('.chat-jump')
      await expect(jump).toContainText('条新消息')
      await jump.click()
      await expect(jump).toHaveCount(0)
      await expect.poll(async () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(30)
    } finally {
      await stop()
    }
  })
})
