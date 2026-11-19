import { mkdir, writeFile } from 'node:fs/promises'
import { launchApplication, expect, test } from './electron'
import { invoke, openPlayer } from './helpers'
import type { SavedRoomMetadata } from '../electron/featureContracts'

const metadata = (patch: Partial<SavedRoomMetadata> = {}): SavedRoomMetadata => ({
  roomId: '100', url: 'https://www.douyu.com/100', nickname: '测试主播', title: '缓存中的直播标题',
  avatarUrl: null, coverUrl: null, status: 'offline', lastStartedAt: Date.now() - 3_600_000, startTimeSource: 'platform', collectedAt: Date.now(), ...patch,
})

test('收藏 YouTube 视频 ID 后显示采集信息并与完整链接去重', async () => {
  const running = await launchApplication('favorite-youtube-id')
  try {
    await running.application.evaluate((_electron, snapshot) => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest: { setSavedRoomFixture(input: string, value: SavedRoomMetadata): void } }
      main.__streamSyncerTest.setSavedRoomFixture('We5j4c4AcDg', snapshot)
    }, metadata({ roomId: 'UC1234567890123456789012', url: 'https://www.youtube.com/channel/UC1234567890123456789012/live',
      nickname: 'YouTube 测试主播', title: 'YouTube 当前直播标题', status: 'live' }))
    await openPlayer(running.page)
    await running.page.getByRole('button', { name: '收藏夹', exact: true }).click()
    const panel = running.page.getByRole('dialog', { name: '收藏直播间', exact: true })
    await panel.getByLabel('收藏平台', { exact: true }).selectOption('youtube')
    const input = panel.getByLabel('收藏直播间链接或房间号')
    await input.fill('We5j4c4AcDg')
    await panel.getByRole('button', { name: '收藏房间', exact: true }).click()
    await expect(panel.getByText('YouTube 测试主播')).toBeVisible()
    await expect(panel.getByText('YouTube 当前直播标题', { exact: true })).toBeVisible()
    await expect(panel.getByText('直播中', { exact: true })).toBeVisible()
    await input.fill('https://www.youtube.com/watch?v=We5j4c4AcDg')
    await panel.getByRole('button', { name: '收藏房间', exact: true }).click()
    await expect(input).toHaveValue('')
    await expect(panel.locator('.favorite-card')).toHaveCount(1)
    await expect(panel.getByText('扩展接口参数无效.', { exact: true })).toHaveCount(0)
  } finally { await running.close() }
})

test('收藏未开播房间, 后台采集, 失败保留缓存并在重启后恢复', async () => {
  test.setTimeout(120_000)
  const running = await launchApplication('favorite-room-cache')
  try {
    await openPlayer(running.page)
    const setFixture = async (value: SavedRoomMetadata | null) => running.application.evaluate((_electron, snapshot) => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest: { setSavedRoomFixture(input: string, value: SavedRoomMetadata | null): void } }
      main.__streamSyncerTest.setSavedRoomFixture('100', snapshot)
    }, value)
    await setFixture(metadata())
    await running.page.getByRole('button', { name: '收藏夹', exact: true }).click()
    let panel = running.page.getByRole('dialog', { name: '收藏直播间', exact: true })
    await panel.getByLabel('收藏直播间链接或房间号').fill('100')
    await panel.getByRole('button', { name: '收藏房间', exact: true }).click()
    await expect(panel.getByText('测试主播')).toBeVisible()
    await expect(panel.getByText('未开播', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    const saved = await invoke(running.page, 'listSavedRooms', undefined)
    expect(saved.ok && saved.value[0]?.metadata?.title).toBe('缓存中的直播标题')
    await setFixture(null)
    await running.page.waitForTimeout(15_100)
    const failedAttempt = await invoke(running.page, 'refreshSavedRooms', undefined)
    expect(failedAttempt.ok).toBe(true)
    if (failedAttempt.ok) expect(failedAttempt.value[0]?.refreshError).toContain('更新失败')
    await running.page.getByRole('button', { name: '收藏夹', exact: true }).click()
    await expect(panel.getByText('缓存中的直播标题', { exact: true })).toBeVisible()
    await expect(panel.getByText('上次更新时未开播', { exact: true })).toBeVisible()
    await expect(panel.getByText('更新失败，显示上次信息', { exact: true })).toBeVisible()
    await running.restart()
    await openPlayer(running.page)
    await running.page.getByRole('button', { name: '收藏夹', exact: true }).click()
    panel = running.page.getByRole('dialog', { name: '收藏直播间', exact: true })
    await expect(panel.getByText('缓存中的直播标题', { exact: true })).toBeVisible()
    await expect(panel.getByText('上次更新时未开播', { exact: true })).toBeVisible()
    await setFixture(metadata({ nickname: '更新后的主播', title: '下一次成功采集的新标题', status: 'live' }))
    await running.page.waitForTimeout(15_100)
    await panel.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(panel.getByText('更新后的主播')).toBeVisible()
    await expect(panel.getByText('下一次成功采集的新标题', { exact: true })).toBeVisible()
    await expect(panel.getByText('直播中', { exact: true })).toBeVisible()
    await expect(panel.getByText('上次更新时未开播', { exact: true })).toHaveCount(0)
    await mkdir('.runtime-cache', { recursive: true })
    await writeFile('.runtime-cache/favorites-desktop.png', await running.page.screenshot())
    await running.application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.setMinimumSize(400, 400)
      window.setSize(520, 740)
    })
    await expect(panel.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible()
    await writeFile('.runtime-cache/favorites-narrow.png', await running.page.screenshot())
    const overflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1)
    expect(overflow).toBe(false)
    await panel.getByLabel('搜索收藏直播间').fill('没有匹配的名字')
    await expect(panel.getByText('没有匹配的收藏直播间', { exact: true })).toBeVisible()
    await panel.getByLabel('搜索收藏直播间').fill('')
    await panel.getByRole('button', { name: '取消收藏', exact: true }).click()
    await expect(panel.getByText('还没有收藏. 未开播的直播间也可以收藏.', { exact: true })).toBeVisible()
  } finally { await running.close() }
})
