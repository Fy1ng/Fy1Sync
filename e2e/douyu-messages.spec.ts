import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { connectDanmaku, disconnectDanmaku, invoke, openPlayer, setPlaying } from './helpers'
import { parseStt, serializeStt, toChatMessage } from '../server/danmaku/douyuProtocol'
import type { DouyuMessageInput } from '../server/douyu/types'

test('同名 cookie 与 dy_did 在主进程共享发送就绪检查, 仅返回缺失字段名', async () => {
  const running = await launchApplication('douyu-credentials')
  try {
    const seed = (missing: boolean) => running.application.evaluate((_electron, missingUsername) => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuCredentialsFixture(missingUsername: boolean): void } }
      main.__streamSyncerTest!.setDouyuCredentialsFixture(missingUsername)
    }, missing)
    await seed(false)
    const ready = await invoke(running.page, 'listDouyuAccounts', undefined)
    expect(ready).toMatchObject({ ok: true, value: { accounts: [{ login: { loggedIn: true, canSend: true, missingCredentialFields: [] } }] } })
    expect(JSON.stringify(ready)).not.toContain('fixture-auth')
    await seed(true)
    expect(await invoke(running.page, 'listDouyuAccounts', undefined)).toMatchObject({
      ok: true, value: { accounts: [{ login: { loggedIn: true, canSend: false, missingCredentialFields: ['acf_username'] } }] },
    })
  } finally { await running.close() }
})

test('网站已登录但缺少发送凭据时, 发送框说明原因并引导重新登录, 不调用发送', async () => {
  const running = await launchApplication('douyu-credentials-ui')
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
        setDouyuCredentialsFixture(missingUsername: boolean): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222' })
      main.__streamSyncerTest!.setDouyuCredentialsFixture(true)
    })
    await openPlayer(running.page)
    await connectDanmaku(running.page, '6657')
    await expect.poll(() => running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
      return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
    })).toBe(1)
    const input = running.page.getByLabel('弹幕内容', { exact: true })
    await expect(input).toBeDisabled()
    await expect(input).toHaveAttribute('placeholder', '需要重新登录斗鱼')
    const drawer = running.page.getByRole('complementary', { name: '弹幕' })
    await expect(drawer.getByRole('status').filter({ hasText: '缺少发送弹幕所需的用户名' })).toBeVisible()
    // The field names stay inside main's diagnostic; the viewer reads what to do.
    await expect(drawer).not.toContainText('acf_username')
    await drawer.getByRole('button', { name: /^重新登录/ }).click()
    const settings = running.page.getByRole('dialog', { name: '设置', exact: true })
    await expect(settings.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: '斗鱼', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(settings.locator('.account')).toContainText('不能发送弹幕，请重新登录')
    const sent = await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { getDouyuSentFixture(): unknown[] } }
      return main.__streamSyncerTest!.getDouyuSentFixture()
    })
    expect(sent).toEqual([])
  } finally { await running.close() }
})

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
    await connectDanmaku(running.page, '6657')
    await setPlaying(running.page, false)
    await expect.poll(() => running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        emitDanmaku(room: string, event: string, data: unknown): number
      } }
      return main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
    })).toBe(1)
    await running.application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })
    const input = running.page.getByLabel('弹幕内容', { exact: true })
    const send = running.page.getByRole('button', { name: '发送', exact: true })
    await input.fill('离线发送 @A/原文')
    await expect(send).toBeEnabled()
    await send.click()
    await expect(running.page.getByRole('status').filter({ hasText: '离线弹幕发送回执' })).toBeVisible()
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
    const row = running.page.locator('.msg').filter({ hasText: text })
    await expect(row).toBeVisible()
    const repeat = row.getByRole('button', { name: '+1：' + text, exact: true })
    await expect(repeat).toHaveText('+1')
    await repeat.click()
    await expect.poll(async () => (await sent()).length).toBe(2)
    expect((await sent())[1]).toEqual({ accountId: 'default', room: '6979222', text, color: 0 })
    await expect(running.page.locator('.msg')).toHaveCount(1)

    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuSendFixtureOutcome(value: 'waiting-user'): void
      } }
      main.__streamSyncerTest!.setDouyuSendFixtureOutcome('waiting-user')
    })
    await input.fill('需要人工核对的消息')
    await send.click()
    await expect(running.page.getByRole('status').filter({ hasText: '离线发送结果待核对' })).toBeVisible()
    await expect(input).toHaveValue('需要人工核对的消息')
    await running.page.waitForTimeout(1100)
    expect(await sent()).toHaveLength(3)
    await input.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-messages.png'), fullPage: true })

    await disconnectDanmaku(running.page)
    await expect(running.page.getByRole('textbox', { name: '弹幕内容', exact: true })).toHaveCount(0)
    await expect.poll(async () => {
      const state = await invoke(running.page, 'getDouyuTasks', undefined)
      return state.ok ? state.value.currentRoom : 'unavailable'
    }).toBeNull()
    expect(await invoke(running.page, 'sendDouyuMessage', { accountId: 'default', room: '6979222', text: '旧房间不能发送', color: 0 }))
      .toMatchObject({ ok: false, code: 'room-changed' })
    expect(await sent()).toHaveLength(3)
  } finally { await running.close() }
})
