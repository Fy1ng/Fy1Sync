import { expect, test } from './electron'
import { connectDanmaku, disconnectDanmaku, invoke, openPlayer, setCheckedByLabel } from './helpers'

interface LotteryFixture {
  setDouyuRoomFixture(mapping: Record<string, string>): void
  setDouyuLotteryFixture(value: { payload: unknown }): void
  getDouyuLotteryFixtureEvidence(): { opened: string[] }
  emitDanmaku(room: string, event: string, data: unknown): number
}

test('主播抽奖通过正常弹幕入口展示, 同文可展开并保留消息归属', async ({ page, electronApp }) => {
  const command = '离线测试抽奖口令'
  await electronApp.evaluate((_electron, text) => {
    const fixture = (globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }).__streamSyncerTest
    fixture.setDouyuRoomFixture({ '6657': '6979222', '6979222': '6979222' })
    const now = Math.floor(Date.now() / 1_000)
    fixture.setDouyuLotteryFixture({ payload: { error: 0, data: {
      room_id: '6979222', activity_id: '456', activity_status: 4, prize_name: '离线抽奖奖品',
      start_at: now - 30, stop_at: now + 120, join_type: 1, join_condition: { command_content: text },
    } } })
  }, command)
  await openPlayer(page)
  await connectDanmaku(page, '6657')
  await expect.poll(() => electronApp.evaluate(() => {
    const fixture = (globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }).__streamSyncerTest
    return fixture.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
  })).toBe(1)
  const card = page.getByRole('region', { name: '斗鱼主播抽奖' })
  await expect(card).toContainText('离线抽奖奖品')
  const reminder = card.getByRole('switch', { name: '抽奖提醒' })
  await expect(reminder).not.toBeChecked()
  await setCheckedByLabel(reminder)
  await expect(page.locator('.toasts')).toContainText('斗鱼主播抽奖 离线抽奖奖品')

  await electronApp.evaluate((_electron, text) => {
    const fixture = (globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }).__streamSyncerTest
    for (const [index, username] of ['较早观众', '本轮观众', '本轮另一观众', '开奖公告'].entries()) {
      fixture.emitDanmaku('6979222', 'danmaku', {
        id: String(index), platform: 'douyu', room: '6979222', username,
        receivedAt: Date.now() - (index === 0 ? 60_000 : 0), text: index === 3 ? '结果请见官方房间' : text,
      })
    }
  }, command)
  const chat = page.getByRole('log', { name: '弹幕列表' })
  const group = chat.getByText('2 条疑似抽奖口令', { exact: true })
  await expect(group).toBeVisible()
  await expect(chat.getByText('较早观众')).toBeVisible()
  await expect(chat.getByText('开奖公告')).toBeVisible()
  await expect(chat.getByText('本轮观众', { exact: true })).toBeHidden()
  await group.click()
  await expect(chat.getByText('本轮观众', { exact: true })).toBeVisible()
  await expect(chat.getByText('本轮另一观众', { exact: true })).toBeVisible()

  expect(await invoke(page, 'openDouyuLotteryRoom', { room: '6979222', activityId: '999' })).toMatchObject({ ok: false, code: 'not-available' })
  await card.getByRole('button', { name: '打开官方房间' }).click()
  await expect.poll(() => electronApp.evaluate(() =>
    (globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }).__streamSyncerTest.getDouyuLotteryFixtureEvidence().opened
  )).toEqual(['https://www.douyu.com/6979222'])

  await disconnectDanmaku(page)
  await expect(card).toHaveCount(0)
  await expect(page.locator('.toasts')).not.toContainText('斗鱼主播抽奖 离线抽奖奖品')
  expect(await invoke(page, 'getDouyuLottery', { room: '6979222' })).toMatchObject({ ok: false, code: 'cancelled' })
})
