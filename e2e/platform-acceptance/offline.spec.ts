import type { ElectronApplication, Locator } from '@playwright/test'
import type { ChatMessage } from '../../server/danmaku/types'
import { expect, test } from '../electron'
import {
  connectDanmaku, fixturesReady, FIXTURES, invoke, loadSource, openDanmakuSettings, openDouyuTab,
  openPlayer, openSettingsSection, revealOverlay, setCheckedByLabel, setPlaying, waitForBothReady,
} from '../helpers'

const firstRoom = '288016'
const secondRoom = '9999'

async function emitRoomMessage(application: ElectronApplication, room: string, text: string, username = '离线观众'): Promise<number> {
  return application.evaluate((_electron, { room, text, username }) => {
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & {
      __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): number }
    }
    fixture.emitDanmaku(room, 'state', { room, state: 'connected' })
    return fixture.emitDanmaku(room, 'danmaku', {
      id: `${room}-${username}-${text}`, room, text, username, color: 0, level: 0,
      receivedAt: Date.now(), system: false,
    } satisfies ChatMessage)
  }, { room, text, username })
}

async function playbackAdvances(video: Locator): Promise<void> {
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2)
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(before + 0.5)
}

test.beforeAll(() => {
  expect(fixturesReady(), '请先运行 npm run fixtures').toBe(true)
})

test.beforeEach(async ({ electronApp }) => {
  await electronApp.evaluate((_electron, rooms) => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('P07 离线场景要求隔离资料和离线运行')
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & {
      __streamSyncerTest: { setDouyuRoomFixture(mapping: Record<string, string>): void; setDouyuToolsFixture(): void }
    }
    fixture.setDouyuRoomFixture(rooms)
    fixture.setDouyuToolsFixture()
  }, { [firstRoom]: firstRoom, [secondRoom]: secondRoom })
})

test('单房播放, 暂停和换账号后分别展示本地、房间与两个官方时长', async ({ page }) => {
  await openPlayer(page)
  await loadSource(page, 'commentary', FIXTURES.commentary)
  await connectDanmaku(page, firstRoom)
  const video = page.locator('video.media-element[data-role="commentary"]')
  await setPlaying(page, true)
  await playbackAdvances(video)
  await setPlaying(page, false)

  const settings = await openSettingsSection(page, '房间数据')
  await expect(settings.locator('.insights-room')).toHaveText(`房间 ${firstRoom}`)
  await expect(settings.getByRole('group', { name: '本地观看时长', exact: true })).toBeVisible()
  await expect(settings).toContainText('本地记录与斗鱼官方观看时长分别统计')
  await expect(settings.getByRole('group', { name: '已播时长', exact: true })).toBeVisible()
  await expect(settings.getByRole('group', { name: '官方今日观看', exact: true })).toContainText('未登录')
  await expect(settings.getByRole('group', { name: '粉丝牌累计观看', exact: true })).toContainText('未知')
  await expect(settings.getByRole('group', { name: '官方观时上报', exact: true })).not.toContainText('粉丝牌累计观时已增长')

  const accounts = await openDouyuTab(page, '账号')
  await accounts.getByLabel('新账号名称', { exact: true }).fill('P07 隔离账号')
  await accounts.getByRole('button', { name: '添加账号', exact: true }).click()
  const second = accounts.getByRole('group', { name: '斗鱼账号 P07 隔离账号', exact: true })
  await second.getByRole('button', { name: '登录', exact: true }).click()
  await expect(second).toContainText('已登录')
  await second.getByRole('button', { name: '设为当前', exact: true }).click()
  await expect(second).toContainText('当前使用')
  const guest = accounts.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
  await guest.getByRole('button', { name: '设为当前', exact: true }).click()
  await expect(guest).toContainText('当前使用')
  await openSettingsSection(page, '房间数据')
  await expect(settings.getByRole('group', { name: '官方今日观看', exact: true })).toContainText('未登录')
  await expect(settings.getByRole('group', { name: '粉丝牌累计观看', exact: true })).toContainText('未知')
})

test('双路播放器切换两个弹幕房间, 不保留旧房内容', async ({ page, electronApp }) => {
  await openPlayer(page)
  await loadSource(page, 'official', FIXTURES.official)
  await loadSource(page, 'commentary', FIXTURES.commentary)
  await waitForBothReady(page)
  await setPlaying(page, true)
  await Promise.all(['official', 'commentary'].map(role =>
    playbackAdvances(page.locator(`video.media-element[data-role="${role}"]`))))
  await setPlaying(page, false)
  await connectDanmaku(page, firstRoom)

  const list = page.getByRole('log', { name: '弹幕列表' })
  await expect.poll(() => emitRoomMessage(electronApp, firstRoom, '离线甲房消息')).toBe(1)
  await expect(list.getByText('离线甲房消息', { exact: true })).toBeVisible()
  await connectDanmaku(page, secondRoom)
  await expect.poll(() => emitRoomMessage(electronApp, secondRoom, '离线乙房消息')).toBe(1)
  await expect(list.getByText('离线乙房消息', { exact: true })).toBeVisible()
  expect(await emitRoomMessage(electronApp, firstRoom, '迟到的甲房消息')).toBe(0)
  await expect(list.getByText(/甲房消息$/)).toHaveCount(0)
  const settings = await openSettingsSection(page, '房间数据')
  await expect(settings.locator('.insights-room')).toHaveText(`房间 ${secondRoom}`)
  await expect(settings.getByRole('group', { name: '官方今日观看', exact: true })).toContainText('未登录')
})

test('同源主窗和增强画中画都能播放, PiP 恢复后仍禁止访客发送', async ({ page, electronApp }) => {
  await openPlayer(page)
  await loadSource(page, 'commentary', FIXTURES.commentary)
  expect(await invoke(page, 'resolve', { input: FIXTURES.commentary, role: 'commentary' })).toMatchObject({ ok: true, value: { ok: true } })
  await connectDanmaku(page, firstRoom)
  await setPlaying(page, true)
  await playbackAdvances(page.locator('video.media-element[data-role="commentary"]'))

  await revealOverlay(page)
  await page.locator('.dock').getByRole('button', { name: '画中画', exact: true }).click()
  const menu = page.getByRole('dialog', { name: '画中画', exact: true })
  const opened = electronApp.waitForEvent('window')
  await menu.getByRole('button', { name: /^增强画中画/ }).click()
  const pip = await opened
  await pip.waitForURL('app://app/pip')
  await expect(pip.locator('.pip-page')).toHaveAttribute('data-phase', 'ready')
  const video = pip.locator('video')
  await playbackAdvances(video)
  await expect(pip.getByRole('textbox', { name: '发送弹幕', exact: true })).toHaveCount(0)
  await pip.getByRole('button', { name: '恢复画面', exact: true }).click()
  await playbackAdvances(video)
  await pip.getByRole('button', { name: '关闭画中画', exact: true }).click()
  await expect.poll(() => pip.isClosed()).toBe(true)
  await expect(page.locator('.drawer-title')).toContainText(firstRoom)
})

test('活动来源未知的口令同文保留两条独立聊天记录', async ({ page, electronApp }) => {
  await openPlayer(page)
  await connectDanmaku(page, firstRoom)
  await setPlaying(page, false)
  const panel = await openDanmakuSettings(page)
  await setCheckedByLabel(panel.getByRole('radio', { name: '全部显示', exact: true }))
  await panel.getByRole('button', { name: '关闭弹幕设置', exact: true }).click()
  const text = 'P07 合成活动同文'
  expect(await emitRoomMessage(electronApp, firstRoom, text, '模拟手打观众')).toBe(1)
  expect(await emitRoomMessage(electronApp, firstRoom, text, '来源未知观众')).toBe(1)
  const list = page.getByRole('log', { name: '弹幕列表' })
  await expect(list.getByText(text, { exact: true })).toHaveCount(2)
  await expect(list.getByText('模拟手打观众', { exact: true })).toBeVisible()
  await expect(list.getByText('来源未知观众', { exact: true })).toBeVisible()
})
