import { test, type Locator } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'
import { parseStt, serializeStt, toChatMessage, toGiftMessage } from '../server/danmaku/douyuProtocol'
import type { ChatMessage } from '../server/danmaku/douyuProtocol'
import type { DouyuMessageInput } from '../server/douyu/types'

test('本地幻神和超火特效可独立关闭, 保留真实消息与赠礼事实, 重启仅恢复设置', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const app = await launchApplication('douyu-local-effects')
  const emit = (messages: ChatMessage[]) => app.application.evaluate((_electron, values) => {
    const fixture = (globalThis as typeof globalThis & { __streamSyncerTest: {
      emitDanmaku(room: string, event: string, data: unknown): number
    } }).__streamSyncerTest
    for (const value of values) fixture.emitDanmaku('9999', 'danmaku', value)
  }, messages)
  const localSettings = async () => {
    await app.page.getByRole('button', { name: '弹幕设置', exact: true }).click()
    await app.page.getByRole('button', { name: /斗鱼本地视觉/ }).click()
    return app.page.locator('.douyu-local-settings')
  }
  const closeSettings = async () => {
    await app.page.getByRole('button', { name: '返回', exact: true }).click()
    await app.page.getByRole('button', { name: '关闭弹幕设置', exact: true }).click()
  }
  const setToggle = async (panel: Locator, label: string, checked: boolean) => {
    const input = panel.getByRole('checkbox', { name: label, exact: true })
    // The shared Toggle uses a zero-sized input and a visible, associated label.
    if (await input.isChecked() !== checked) await panel.getByText(label, { exact: true }).click()
    if (checked) await expect(input).toBeChecked()
    else await expect(input).not.toBeChecked()
  }
  try {
    await app.application.evaluate(() => {
      const fixture = (globalThis as typeof globalThis & { __streamSyncerTest: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }).__streamSyncerTest
      fixture.setDouyuToolsFixture()
      fixture.setDouyuRoomFixture({ '9999': '9999' })
    })
    await openPlayer(app.page)
    await app.page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await invoke(app.page, 'loginDouyuAccount', { id: 'default' })).toMatchObject({ ok: true })
    const dialog = await openSourceDialog(app.page)
    await dialog.getByRole('textbox', { name: '弹幕房间号', exact: true }).fill('9999')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => app.application.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } })
        .__streamSyncerTest.emitDanmaku('9999', 'state', { room: '9999', state: 'connected' }))).toBe(1)
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await app.application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })

    const settings = await localSettings()
    const identity = settings.getByRole('checkbox', { name: '本地幻神装扮', exact: true })
    const gifts = settings.getByRole('checkbox', { name: '荧光棒显示本地超火特效', exact: true })
    await expect(identity).not.toBeChecked()
    await expect(gifts).not.toBeChecked()
    await setToggle(settings, '本地幻神装扮', true)
    await settings.getByLabel('要装饰的斗鱼用户 ID').fill('42')
    await setToggle(settings, '荧光棒显示本地超火特效', true)
    await app.page.screenshot({ path: testInfo.outputPath('local-effects-settings.png'), fullPage: true })
    await closeSettings()

    const text = '这条弹幕保留原文'
    const chat = toChatMessage(parseStt(serializeStt({ type: 'chatmsg', cid: 'local-identity', uid: '42', nn: '测试观众', level: 1, nl: 0, txt: text })), '9999', Date.now())!
    const gift = () => toGiftMessage(parseStt(serializeStt({ type: 'dgb', rid: '9999', uid: '42', nn: '测试观众', gpf: 1, pid: '268', gfcnt: 2 })), '9999', Date.now())!
    await emit([chat, gift()])
    const chatRow = app.page.locator('.chat-row').filter({ hasText: text })
    const giftRow = app.page.locator('.chat-row').filter({ hasText: '粉丝荧光棒 x 2' })
    await expect(chatRow.locator('.douyu-local-identity')).toHaveText('本地幻神')
    await expect(giftRow).toBeVisible()
    await expect(giftRow.getByRole('button')).toHaveCount(0)
    const effect = app.page.locator('[data-local-effect="super-rocket"]')
    await expect(effect).toBeVisible()
    await expect(effect).toHaveAttribute('data-motion', 'reduced')
    await expect(effect).toContainText('粉丝荧光棒 x 2')
    await expect(effect).toContainText('测试观众')
    await chatRow.scrollIntoViewIfNeeded()
    await app.page.screenshot({ path: testInfo.outputPath('local-effects-active.png'), fullPage: true })
    await chatRow.getByRole('button').click()
    await expect.poll(() => app.application.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { getDouyuSentFixture(): DouyuMessageInput[] } })
        .__streamSyncerTest.getDouyuSentFixture())).toEqual([{ accountId: 'default', room: '9999', text, color: 0 }])
    await expect(app.page.locator('.chat-row')).toHaveCount(2)

    const reopened = await localSettings()
    await emit([gift()])
    await expect(effect.first()).toBeVisible()
    await setToggle(reopened, '荧光棒显示本地超火特效', false)
    await expect(effect).toHaveCount(0, { timeout: 500 })
    await expect(chatRow.locator('.douyu-local-identity')).toHaveCount(1)
    await setToggle(reopened, '本地幻神装扮', false)
    await expect(chatRow.locator('.douyu-local-identity')).toHaveCount(0)
    await setToggle(reopened, '本地幻神装扮', true)
    await setToggle(reopened, '荧光棒显示本地超火特效', true)
    await closeSettings()
    await app.restart()
    await openPlayer(app.page)
    const restored = await localSettings()
    await expect(restored.getByRole('checkbox', { name: '本地幻神装扮', exact: true })).toBeChecked()
    await expect(restored.getByRole('checkbox', { name: '荧光棒显示本地超火特效', exact: true })).toBeChecked()
    await expect(restored.getByLabel('要装饰的斗鱼用户 ID')).toHaveValue('42')
    await expect(app.page.locator('[data-local-effect="super-rocket"]')).toHaveCount(0)
  } finally { await app.close() }
})
