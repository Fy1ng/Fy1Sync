import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'
import { parseStt, serializeStt, toChatMessage } from '../server/danmaku/douyuProtocol'
import type { DouyuMessageInput } from '../server/douyu/types'

test('手动发送和 +1 使用当前账号及真实房间, 未知结果保留草稿且不重发', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const running = await launchApplication('douyu-messages')
  const sent = () => running.application.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { getDouyuSentFixture(): DouyuMessageInput[] } }
    return main.__streamSyncerTest!.getDouyuSentFixture()
  })
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
    const dialog = await openSourceDialog(running.page)
    await dialog.getByRole('textbox', { name: '弹幕房间号', exact: true }).fill('6657')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(() => running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        emitDanmaku(room: string, event: string, data: unknown): number
      } }
      return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
    })).toBe(1)
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await running.application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })
    const input = running.page.getByLabel('弹幕内容', { exact: true })
    const send = running.page.getByRole('button', { name: '发送', exact: true })
    await input.fill('离线发送 @A/原文')
    await expect(send).toBeEnabled()
    await send.click()
    await expect(running.page.getByText('离线弹幕发送回执', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('')
    expect(await sent()).toEqual([{ accountId: 'default', room: '6979222', text: '离线发送 @A/原文', color: 0 }])
    expect((await invoke(running.page, 'getDouyuTasks', undefined))).toMatchObject({ ok: true, value: { tasks: [] } })

    const text = '复读 @A/ 原文 \\保留'
    const payload = toChatMessage(parseStt(serializeStt({ type: 'chatmsg', cid: 'repeat-fixture', uid: '42', nn: '测试观众', txt: text })), '6979222', Date.now())
    await running.application.evaluate((_electron, data) => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        emitDanmaku(room: string, event: string, data: unknown): number
      } }
      main.__streamSyncerTest!.emitDanmaku('6979222', 'danmaku', data)
    }, payload)
    const row = running.page.locator('.chat-row').filter({ hasText: text })
    await expect(row).toBeVisible()
    await expect(row.getByRole('button')).toHaveText('+1')
    await row.getByRole('button').click()
    await expect.poll(async () => (await sent()).length).toBe(2)
    expect((await sent())[1]).toEqual({ accountId: 'default', room: '6979222', text, color: 0 })
    await expect(running.page.locator('.chat-row')).toHaveCount(1)

    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuSendFixtureOutcome(value: 'waiting-user'): void
      } }
      main.__streamSyncerTest!.setDouyuSendFixtureOutcome('waiting-user')
    })
    await input.fill('需要人工核对的消息')
    await send.click()
    await expect(running.page.getByText('离线发送结果待核对', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('需要人工核对的消息')
    await running.page.waitForTimeout(1100)
    expect(await sent()).toHaveLength(3)
    await input.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-messages.png'), fullPage: true })

    const reopened = await openSourceDialog(running.page)
    await reopened.getByRole('button', { name: '断开', exact: true }).click()
    await reopened.getByRole('button', { name: '完成', exact: true }).click()
    await expect(running.page.getByRole('form', { name: '发送斗鱼弹幕' })).toHaveCount(0)
    await expect.poll(async () => {
      const state = await invoke(running.page, 'getDouyuTasks', undefined)
      return state.ok ? state.value.currentRoom : 'unavailable'
    }).toBeNull()
    expect(await invoke(running.page, 'sendDouyuMessage', { accountId: 'default', room: '6979222', text: '旧房间不能发送', color: 0 }))
      .toMatchObject({ ok: false, code: 'room-changed' })
    expect(await sent()).toHaveLength(3)
  } finally { await running.close() }
})
