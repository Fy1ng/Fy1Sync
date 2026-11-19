import type { ElectronApplication } from '@playwright/test'
import { expect, test } from '../electron'
import { connectDanmaku, openPlayer, setCheckedByLabel, setPlaying } from '../helpers'

const firstRoom = '288016'
const secondRoom = '9999'
const command = 'P07 同文字活动口令'
const prize = 'P07 离线奖品'
const notice = `斗鱼主播抽奖 ${prize}`

interface LotteryFixture {
  setDouyuRoomFixture(mapping: Record<string, string>): void
  setDouyuLotteryFixture(value: { payload: unknown }): void
  emitDanmaku(room: string, event: string, data: unknown): number
}

async function connectFixture(application: ElectronApplication, room: string): Promise<void> {
  await expect.poll(() => application.evaluate((_electron, selectedRoom) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }
    return main.__streamSyncerTest.emitDanmaku(selectedRoom, 'state', { room: selectedRoom, state: 'connected' })
  }, room)).toBe(1)
}

test('斗鱼有效期同文保留原行, 活动到期及切房后撤下提醒', async ({ page, electronApp }) => {
  test.skip(process.env.STREAM_SYNC_P07_INTEGRATED !== '1', '此用例要求有斗鱼活动夹具的集成构建')
  await openPlayer(page)
  await electronApp.evaluate((_electron, { firstRoom, secondRoom, command, prize }) => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('P07 活动场景要求隔离离线运行')
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }
    fixture.setDouyuRoomFixture({ [firstRoom]: firstRoom, [secondRoom]: secondRoom })
    fixture.setDouyuLotteryFixture({ payload: { error: 0, data: {
      room_id: firstRoom, activity_id: '456', activity_status: 4, prize_name: prize, join_type: 1,
      start_at: Math.floor(Date.now() / 1000) - 30, stop_at: Math.floor(Date.now() / 1000) + 17,
      join_condition: { command_content: command },
    } } })
  }, { firstRoom, secondRoom, command, prize })
  await connectDanmaku(page, firstRoom)
  await setPlaying(page, false)
  await connectFixture(electronApp, firstRoom)

  const card = page.getByRole('region', { name: '斗鱼主播抽奖', exact: true })
  await expect(card).toContainText(prize)
  const reminders = card.getByRole('switch', { name: '抽奖提醒', exact: true })
  await setCheckedByLabel(reminders)
  const notices = page.locator('.toasts').getByText(notice, { exact: false })
  await expect(notices).toHaveCount(1)

  const emitPair = (expired: boolean) => electronApp.evaluate((_electron, { room, text, expired }) => {
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & { __streamSyncerTest: LotteryFixture }
    const names = expired ? ['活动结束后的观众'] : ['模拟手打观众', '来源未知观众']
    for (const username of names) fixture.emitDanmaku(room, 'danmaku', {
      id: `p07-${username}`, room, text, username, color: 0, level: 0,
      receivedAt: Date.now(), system: false,
    })
  }, { room: firstRoom, text: command, expired })

  await emitPair(false)
  const log = page.getByRole('log', { name: '弹幕列表', exact: true })
  const clue = log.getByText('2 条疑似抽奖口令', { exact: true })
  await expect(clue).toBeVisible()
  await clue.click()
  await expect(log.getByText('模拟手打观众', { exact: true })).toBeVisible()
  await expect(log.getByText('来源未知观众', { exact: true })).toBeVisible()
  await expect(log.getByText(command, { exact: true })).toHaveCount(2)

  const countdown = card.getByLabel('真实开奖倒计时')
  await setCheckedByLabel(reminders, false)
  await expect(notices).toHaveCount(0)
  await setCheckedByLabel(reminders)
  await expect(countdown).toBeVisible()
  await expect(notices).toHaveCount(0)
  await expect(countdown).toHaveCount(0, { timeout: 20_000 })
  await expect(notices).toHaveCount(0)
  await emitPair(true)
  await expect(log.getByText('活动结束后的观众', { exact: true })).toBeVisible()

  await connectDanmaku(page, secondRoom)
  await connectFixture(electronApp, secondRoom)
  await expect(card).not.toContainText(prize)
  await expect(log.getByText(command, { exact: true })).toHaveCount(0)
  await expect(notices).toHaveCount(0)
})
