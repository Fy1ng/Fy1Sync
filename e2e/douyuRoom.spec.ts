import { test, expect } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'

test('数字靓号经主进程静态元数据解析并显示实际弹幕房间', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuRoomFixture(mapping: Record<string, string | null>): void } }
    main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222', '6979222': '6979222', '999999999999': null })
  })
  await openPlayer(page)
  expect(await invoke(page, 'resolveDouyuRoom', { input: '6657' })).toMatchObject({ ok: true, value: { ok: true, identity: { room: '6979222', inputRoom: '6657' } } })
  expect(await invoke(page, 'resolveDouyuRoom', { input: 'https://www.douyu.com/topic/x?rid=6657' })).toMatchObject({ ok: true, value: { ok: true, identity: { room: '6979222' } } })
  expect(await invoke(page, 'resolveDouyuRoom', { input: '999999999999' })).toMatchObject({ ok: true, value: { ok: false, failure: { code: 'room-not-found' } } })
  const dialog = await openSourceDialog(page)
  await dialog.getByRole('textbox', { name: '弹幕房间号' }).fill('6657')
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect.poll(() => electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
    return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
  })).toBe(1)
  await expect(dialog.locator('.danmaku-room')).toContainText('已连接房间 6979222')
  await dialog.getByRole('button', { name: '断开', exact: true }).click()
  await expect(dialog.locator('.danmaku-room')).toContainText('未连接弹幕')
})
