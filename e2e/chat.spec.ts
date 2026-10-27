/**
 * The sidebar chat list under load: 200 messages a second through the real relay, IPC,
 * timeline and windowing. The point is that the DOM stays bounded while the history grows,
 * and that a reader scrolled up is not moved by arriving messages.
 */

import { APP_ORIGIN, expect, test } from './electron'
import { connectDanmaku, fixturesReady, loadBothFixtures, openPlayer, seekBoth, setCheckedByLabel, setPlaying, stressDanmaku } from './helpers'
import { parseStt, serializeStt, toChatMessage, toGiftMessage } from '../server/danmaku/douyuProtocol'
import { SETTINGS_KEY } from '../src/app/settings'

test('旧配置不恢复已移除的本地视觉, 普通弹幕设置和真实礼物通知仍正常', async ({ page, electronApp }, testInfo) => {
  const consoleErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ danmaku: {
    localPhantomIdentity: true, localPhantomUid: '42', localGlowstickToRocket: true,
    fontSize: 30, opacity: 0.5,
  } })), SETTINGS_KEY)
  await openPlayer(page)
  await expect(page).toHaveURL(APP_ORIGIN + '/')
  await expect(page).toHaveTitle('Fy1Sync')
  await page.getByRole('button', { name: '弹幕设置', exact: true }).click()
  const panel = page.locator('.float-panel')
  await expect(panel.getByRole('heading', { name: '弹幕', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: /斗鱼本地视觉/ })).toHaveCount(0)
  await expect(panel.getByRole('switch', { name: '显示弹幕', exact: true })).toBeChecked()
  const gifts = panel.getByRole('switch', { name: /^显示礼物消息/ })
  await expect(gifts).not.toBeChecked()
  await setCheckedByLabel(gifts)
  const fontSize = panel.getByRole('slider', { name: '字号', exact: true })
  await expect(fontSize).toHaveValue('30')
  await fontSize.focus()
  await fontSize.press('ArrowRight')
  await expect(fontSize).toHaveValue('31')
  const persisted = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).danmaku, SETTINGS_KEY)
  expect(persisted).toMatchObject({ fontSize: 31, opacity: 0.5 })
  expect(persisted).not.toHaveProperty('localPhantomIdentity')
  expect(persisted).not.toHaveProperty('localPhantomUid')
  expect(persisted).not.toHaveProperty('localGlowstickToRocket')
  await page.screenshot({ path: testInfo.outputPath('danmaku-settings.png') })
  await page.getByRole('button', { name: '关闭弹幕设置', exact: true }).click()

  await connectDanmaku(page)
  await setPlaying(page, false)
  await expect.poll(() => electronApp.evaluate(() =>
    (globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } })
      .__streamSyncerTest.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' }))).toBe(1)
  const messages = [
    toChatMessage(parseStt(serializeStt({ type: 'chatmsg', uid: '42', nn: '原始观众', txt: '保留原始弹幕' })), '288016', Date.now()),
    toGiftMessage(parseStt(serializeStt({ type: 'dgb', rid: '288016', uid: '42', nn: '原始观众', gpf: 1, pid: '268', gfcnt: 2 })), '288016', Date.now()),
  ]
  expect(messages.every(Boolean)).toBe(true)
  await electronApp.evaluate((_electron, payloads) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number } }
    for (const payload of payloads) main.__streamSyncerTest.emitDanmaku('288016', 'danmaku', payload)
  }, messages)
  await expect(page.locator('.msg')).toHaveCount(2)
  const giftRow = page.locator('.msg').filter({ hasText: '粉丝荧光棒 x 2' })
  await expect(giftRow).toBeVisible()
  await expect(giftRow.getByRole('button')).toHaveCount(0)
  const overlay = page.locator('.danmaku-stage')
  await expect(overlay.locator(':scope > *')).toHaveCount(1)
  await expect(overlay.locator('.danmaku-item')).toHaveText('保留原始弹幕')
  await expect(overlay.locator('.danmaku-item > *')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('chat-and-gift-notification.png') })
  expect(consoleErrors).toEqual([])
})

test('斗鱼协议昵称经 IPC 显示, 缺失昵称才显示匿名', async ({ page, electronApp }) => {
  await openPlayer(page)
  await connectDanmaku(page)
  await setPlaying(page, false)
  await expect.poll(() => electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
    return main.__streamSyncerTest!.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
  })).toBe(1)

  const messages = [
    'type@=chatmsg/cid@=named/nn@=观众@A甲@S乙/txt@=昵称回归消息/col@=2/',
    'type@=chatmsg/cid@=unnamed/txt@=缺失昵称消息/',
  ].map((payload) => toChatMessage(parseStt(payload), '288016', Date.now()))
  expect(messages.every(Boolean)).toBe(true)
  await electronApp.evaluate((_electron, payloads) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number } }
    for (const payload of payloads) main.__streamSyncerTest!.emitDanmaku('288016', 'danmaku', payload)
  }, messages)

  const rows = page.locator('.msg')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: '昵称回归消息' }).locator('.msg-user')).toHaveText('观众@甲/乙')
  await expect(rows.filter({ hasText: '缺失昵称消息' }).locator('.msg-user')).toHaveText('匿名')
  await expect(page.locator('.danmaku-item').filter({ hasText: '昵称回归消息' })).toHaveCSS('color', 'rgb(30, 135, 240)')
})

test.describe('弹幕列表', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('每秒 200 条时列表节点数有上限，往上翻看时不被推走', async ({ page, electronApp }) => {
    const stop = await stressDanmaku(electronApp, 200)
    try {
      await openPlayer(page)
      await loadBothFixtures(page)
      await seekBoth(page, 3, 3)
      await setPlaying(page, true)

      await connectDanmaku(page)

      const list = page.locator('.drawer-scroll')
      await expect(list.locator('.msg').first()).toBeVisible({ timeout: 20_000 })
      await expect(list.locator('.msg-user').first()).toHaveText(/^观众\d+$/)

      // Let the history outgrow the viewport many times over.
      await expect.poll(async () => list.evaluate((node) => node.scrollHeight / node.clientHeight), { timeout: 20_000 })
        .toBeGreaterThan(20)
      const rows = await list.locator('.msg').count()
      // A real viewport, or windowing is measuring nothing.
      expect(await list.evaluate((node) => node.clientHeight)).toBeGreaterThan(200)
      // Bound the DOM by this actual viewport, not by the old sidebar's fixed height.
      const rowLimit = await list.evaluate(node => {
        const row = node.querySelector('.msg')!
        return Math.ceil(node.clientHeight / row.getBoundingClientRect().height) + 13
      })
      expect(rows).toBeGreaterThan(0)
      expect(rows).toBeLessThanOrEqual(rowLimit)

      // Following the bottom while pinned.
      expect(await list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(30)

      // Scroll up and remember a row; it must stay put as messages keep arriving.
      await list.evaluate((node) => { node.scrollTop = node.scrollHeight / 2 })
      await page.waitForTimeout(300)
      const anchor = list.locator('.msg').nth(8)
      const text = await anchor.locator('.msg-text').textContent()
      const before = await list.getByText(text!, { exact: true }).boundingBox()
      await page.waitForTimeout(1500)
      const after = await list.getByText(text!, { exact: true }).boundingBox()
      expect(after).not.toBeNull()
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2)
      expect(await list.locator('.msg').count()).toBeLessThanOrEqual(rowLimit)

      const jump = page.locator('.drawer-jump')
      await expect(jump).toContainText('条新弹幕')
      await jump.click()
      await expect(jump).toHaveCount(0)
      await expect.poll(async () => list.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(30)
    } finally {
      await stop()
    }
  })
})
