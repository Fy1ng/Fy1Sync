import { expect, test } from './electron'
import { connectDanmaku, openPlayer, setPlaying } from './helpers'

const LIST_TEXT = 'Fy1Sync synthetic clipboard list 20261102'
const STAGE_TEXT = 'Fy1Sync synthetic clipboard stage 20261102'

test('弹幕列表和画面菜单通过真实剪贴板写入, 读取权限保持拒绝', async ({ electronApp, page }) => {
  const protectedClipboard = await electronApp.evaluate(async ({ clipboard, ClipboardItem }) => {
    try {
      // Materialize every exposed format before the test overwrites it, including native custom formats.
      const items = await clipboard.read()
      const saved = await Promise.all(items.map(async item => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async type => [type, await item.getType(type)])),
      ))))
      const main = globalThis as typeof globalThis & { __copyClipboardBackup?: Electron.ClipboardItem[] }
      main.__copyClipboardBackup = saved
      return true
    } catch { return false }
  })
  test.skip(!protectedClipboard, '当前剪贴板含 Electron 无法原子恢复的格式, 保留原内容并跳过系统剪贴板写入.')
  try {
    await openPlayer(page)
    await connectDanmaku(page)
    await setPlaying(page, false)
    await expect.poll(() => electronApp.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } })
        .__streamSyncerTest.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' }))).toBe(1)
    await electronApp.evaluate((_electron, texts) => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } }
      for (const [index, text] of texts.entries()) main.__streamSyncerTest.emitDanmaku('288016', 'danmaku', {
        id: `copy-${index}`, room: '288016', text, username: '合成观众', color: 0, level: 1, receivedAt: Date.now(), system: false,
      })
    }, [LIST_TEXT, STAGE_TEXT])
    const list = page.getByRole('log', { name: '弹幕列表' })
    const row = list.locator('.msg').filter({ hasText: LIST_TEXT })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: `更多操作：${LIST_TEXT}`, exact: true }).click()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => electronApp.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, LIST_TEXT)).toBe(true)
    await expect(page.getByText('弹幕已复制', { exact: true }).first()).toBeVisible()

    const item = page.locator('.danmaku-stage .danmaku-item').filter({ hasText: STAGE_TEXT })
    await expect(item).toBeVisible()
    // Scrolling text never settles for Playwright's default stability check.
    await item.hover({ force: true })
    const menu = page.getByRole('toolbar', { name: `弹幕操作：${STAGE_TEXT}`, exact: true })
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: '复制', exact: true }).click()
    await expect.poll(() => electronApp.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, STAGE_TEXT)).toBe(true)
    await expect(page.getByText('弹幕已复制', { exact: true }).first()).toBeVisible()
    const readDenied = await page.evaluate(async () => {
      try { await navigator.clipboard.readText(); return false } catch { return true }
    })
    expect(readDenied).toBe(true)
  } finally {
    await electronApp.evaluate(async ({ clipboard }, expected) => {
      const main = globalThis as typeof globalThis & { __copyClipboardBackup?: Electron.ClipboardItem[] }
      const backup = main.__copyClipboardBackup
      // A user may copy something during this test. Never replace that newer clipboard.
      if (backup && expected.includes(await clipboard.readText())) {
        if (backup.length === 0) clipboard.clear()
        else await clipboard.write(backup)
      }
      delete main.__copyClipboardBackup
    }, [LIST_TEXT, STAGE_TEXT])
  }
})
