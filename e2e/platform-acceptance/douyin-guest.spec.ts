import { expect, test } from '../electron'
import { connectDanmaku, fixturesReady, openPlayer, openSettingsSection } from '../helpers'

test('抖音访客可以读弹幕, 发送保持禁用', async ({ page, electronApp }) => {
  expect(fixturesReady(), '需要本地合成媒体素材').toBe(true)
  await electronApp.evaluate(() => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('P07 抖音访客场景要求离线运行')
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & {
      __streamSyncerTest: { setDouyinSendFixture(value: 'logged-out'): void }
    }
    fixture.setDouyinSendFixture('logged-out')
  })

  await openPlayer(page)
  await connectDanmaku(page, 'douyin:100')
  const composer = page.getByRole('form', { name: '抖音弹幕发送' })
  await expect(composer.getByRole('textbox', { name: '抖音弹幕内容' })).toBeDisabled()
  await expect(composer.getByRole('button', { name: '登录抖音', exact: true })).toBeVisible()

  const text = 'P07 抖音访客可读消息'
  expect(await electronApp.evaluate((_electron, text) => {
    const { __streamSyncerTest: fixture } = globalThis as typeof globalThis & {
      __streamSyncerTest: {
        emitDanmaku(room: string, event: string, data: unknown): number
        getDouyinSendFixture(): { sent: unknown[]; tokenRequests: number }
      }
    }
    const room = 'douyin:100'
    const receivers = fixture.emitDanmaku(room, 'danmaku', {
      id: 'p07-douyin-guest', room, platform: 'douyin', text, username: 'P07 抖音观众',
      color: 0, level: 0, receivedAt: Date.now(), system: false,
    })
    const { sent, tokenRequests } = fixture.getDouyinSendFixture()
    return { receivers, sent, tokenRequests }
  }, text)).toEqual({ receivers: 1, sent: [], tokenRequests: 0 })
  await expect(page.getByRole('log', { name: '弹幕列表' }).getByText(text, { exact: true })).toBeVisible()

  if (process.env.STREAM_SYNC_P07_FULL_CANDIDATE === '1') {
    const settings = await openSettingsSection(page, '房间数据')
    await expect(settings.getByText(/本房官方今日和累计观看时长未知/)).toBeVisible()
    await expect(settings.getByText(/普通福袋开奖时间是活动信息/)).toBeVisible()
  }
})
