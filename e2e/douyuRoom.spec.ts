import { test, expect } from './electron'
import { connectDanmaku, disconnectDanmaku, invoke, openPlayer, openSourcePanel } from './helpers'

test('数字靓号显示原输入并经主进程解析连接实际弹幕房间', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuRoomFixture(mapping: Record<string, string | null>): void } }
    main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222', '6979222': '6979222', '999999999999': null })
  })
  await openPlayer(page)
  expect(await invoke(page, 'resolveDouyuRoom', { input: '6657' })).toMatchObject({ ok: true, value: { ok: true, identity: { room: '6979222', inputRoom: '6657' } } })
  expect(await invoke(page, 'resolveDouyuRoom', { input: 'https://www.douyu.com/topic/x?rid=6657' })).toMatchObject({ ok: true, value: { ok: true, identity: { room: '6979222' } } })
  expect(await invoke(page, 'resolveDouyuRoom', { input: '999999999999' })).toMatchObject({ ok: true, value: { ok: false, failure: { code: 'room-not-found' } } })
  await connectDanmaku(page, '6657')
  await expect.poll(() => electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
    return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
  })).toBe(1)
  await expect(page.locator('.drawer-title')).toHaveText('房间 6657')
  const panel = await openSourcePanel(page, 'commentary')
  await expect(panel).toContainText('房间 6657')
  await page.keyboard.press('Escape')
  await disconnectDanmaku(page)
  await expect(page.locator('.drawer')).toHaveCount(0)
})
