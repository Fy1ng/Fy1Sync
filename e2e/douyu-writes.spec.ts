import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { connectDanmaku, invoke, openDouyuDesk, openPlayer, setCheckedByLabel } from './helpers'

test('斗鱼写操作默认关闭: 只读功能照常, 确认风险后才出现发送与任务入口', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const running = await launchApplication('douyu-writes-gate')
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222' })
    })
    await openPlayer(running.page)
    expect(await invoke(running.page, 'loginDouyuAccount', { id: 'default' })).toMatchObject({ ok: true })
    await connectDanmaku(running.page, '6657')
    await expect.poll(() => running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
      return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
    })).toBe(1)
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
      main.__streamSyncerTest!.emitDanmaku('6979222', 'danmaku', {
        id: 'writes-gate', text: '只读验收', username: '离线观众', sender: { uid: '42', level: 8 },
        color: 0, level: 8, receivedAt: Date.now(), room: '6979222', system: false,
      })
    })
    const drawer = running.page.getByRole('complementary', { name: '弹幕' })
    const row = drawer.getByRole('log', { name: '弹幕列表' }).locator('.msg').filter({ hasText: '只读验收' })
    await expect(row).toBeVisible()
    await expect(drawer.getByRole('textbox', { name: '弹幕内容', exact: true })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^\+1/ })).toHaveCount(0)
    await row.getByRole('button', { name: /^更多操作/ }).click()
    const menu = running.page.getByRole('dialog', { name: /^弹幕操作/ })
    await expect(menu.getByRole('button', { name: '收藏', exact: true })).toBeVisible()
    await expect(menu.getByRole('button', { name: '回复', exact: true })).toHaveCount(0)
    await expect(menu.getByRole('button', { name: '禁言', exact: true })).toHaveCount(0)
    await running.page.keyboard.press('Escape')

    const desk = await openDouyuDesk(running.page)
    const tabs = desk.getByRole('tablist', { name: '斗鱼' })
    for (const name of ['账号', '关注', '背包']) await expect(tabs.getByRole('tab', { name: new RegExp('^' + name) })).toBeVisible()
    for (const name of ['房间任务', '批量任务', '粉丝牌']) await expect(tabs.getByRole('tab', { name: new RegExp('^' + name) })).toHaveCount(0)
    await tabs.getByRole('tab', { name: /^背包/ }).click()
    await expect(desk.getByRole('region', { name: '赠送', exact: true })).toHaveCount(0)

    await tabs.getByRole('tab', { name: /^实验性/ }).click()
    const toggle = desk.getByRole('switch', { name: /^斗鱼写操作/ })
    await expect(toggle).not.toBeChecked()
    await toggle.locator('..').click()
    await desk.getByRole('button', { name: '取消', exact: true }).click()
    await expect(toggle).not.toBeChecked()
    await toggle.locator('..').click()
    await desk.getByRole('button', { name: '确认打开', exact: true }).click()
    await expect(toggle).toBeChecked()
    for (const name of ['房间任务', '批量任务', '粉丝牌']) await expect(tabs.getByRole('tab', { name: new RegExp('^' + name) })).toBeVisible()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-writes-gate.png'), fullPage: true })
    await desk.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(drawer.getByRole('textbox', { name: '弹幕内容', exact: true })).toBeVisible()

    // Nothing reached the send fixture while the switch was being exercised.
    const sent = await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { getDouyuSentFixture(): unknown[] } }
      return main.__streamSyncerTest!.getDouyuSentFixture()
    })
    expect(sent).toEqual([])
    await running.restart()
    await openPlayer(running.page)
    const reopened = await openDouyuDesk(running.page)
    await reopened.getByRole('tablist', { name: '斗鱼' }).getByRole('tab', { name: /^实验性/ }).click()
    const persisted = reopened.getByRole('switch', { name: /^斗鱼写操作/ })
    await expect(persisted).toBeChecked()
    await setCheckedByLabel(persisted, false)
    await expect(reopened.getByRole('tablist', { name: '斗鱼' }).getByRole('tab', { name: /^房间任务/ })).toHaveCount(0)

  } finally { await running.close() }
})
