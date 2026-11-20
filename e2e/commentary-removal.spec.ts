import { expect, test } from './electron'
import { connectDanmaku, disconnectDanmaku, fixturesReady, loadBothFixtures, openPlayer, openSourcePanel, setPlaying } from './helpers'
import { SETTINGS_KEY } from '../src/app/settings'

test('移除两路片源保留手动房间, 主动断开后不恢复旧房间', async ({ page, electronApp }) => {
  test.skip(!fixturesReady(), 'Run npm run fixtures to create the isolated media sources')
  const emit = (text: string) => electronApp.evaluate((_electron, text) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } }
    main.__streamSyncerTest.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
    return main.__streamSyncerTest.emitDanmaku('288016', 'danmaku', { room: '288016', text, username: 'synthetic viewer', color: 0, platform: 'douyu' })
  }, text)
  await openPlayer(page)
  await loadBothFixtures(page)
  await connectDanmaku(page)
  await setPlaying(page, false)
  await expect.poll(() => emit('REMOVAL_OLD_ROOM')).toBe(1)
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText('REMOVAL_OLD_ROOM', { exact: true }).first()).toBeVisible()

  await page.getByRole('button', { name: '隐藏小画面', exact: true }).click()
  const showPreview = page.getByRole('button', { name: '显示小画面', exact: true })
  await expect(showPreview).toBeVisible()
  await expect(page.locator('.drawer')).toBeVisible()
  const official = await openSourcePanel(page, 'official')
  await official.getByRole('button', { name: '移除', exact: true }).click()
  await expect(page.locator('.chip[data-role="official"]')).toHaveAttribute('data-status', 'empty')
  await expect(showPreview).toHaveCount(0)
  await expect(page.locator('.drawer')).toBeVisible()
  expect(await emit('REMOVAL_OFFICIAL_KEEPS_CHAT')).toBe(1)
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText('REMOVAL_OFFICIAL_KEEPS_CHAT', { exact: true })).toBeVisible()
  const savedSettings = await page.evaluate(key => localStorage.getItem(key), SETTINGS_KEY)

  const commentary = await openSourcePanel(page, 'commentary')
  await commentary.getByRole('button', { name: '移除', exact: true }).click()
  await expect(page.locator('.chip[data-role="commentary"]')).toHaveAttribute('data-status', 'empty')
  await expect(page.locator('.drawer')).toBeVisible()
  expect(await emit('REMOVAL_COMMENTARY_KEEPS_CHAT')).toBe(1)
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText('REMOVAL_COMMENTARY_KEEPS_CHAT', { exact: true })).toBeVisible()
  await disconnectDanmaku(page)
  await expect(page.locator('.studio')).toHaveAttribute('data-chat', 'closed')
  await expect(page.getByRole('log', { name: '弹幕列表' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '展开弹幕', exact: true })).toHaveCount(0)
  await expect(page.locator('.danmaku-item')).toHaveCount(0)
  await expect.poll(() => emit('REMOVAL_LATE_EVENT')).toBe(0)
  expect(await page.evaluate(key => localStorage.getItem(key), SETTINGS_KEY)).toBe(savedSettings)

  await page.reload()
  await openPlayer(page)
  await expect(page.locator('.studio')).toBeVisible()
  expect(await emit('REMOVAL_PARKED_EVENT')).toBe(0)
  await expect(page.getByRole('log', { name: '弹幕列表' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '展开弹幕', exact: true })).toHaveCount(0)

  await connectDanmaku(page)
  await setPlaying(page, false)
  await expect.poll(() => emit('REMOVAL_NEW_CONNECTION')).toBe(1)
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText('REMOVAL_NEW_CONNECTION', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText(/REMOVAL_OLD_ROOM|REMOVAL_LATE_EVENT|REMOVAL_PARKED_EVENT/)).toHaveCount(0)
})
