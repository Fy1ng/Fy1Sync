import { expect, test } from './electron'
import { connectDanmaku, invoke, openPlayer, openSettingsSection } from './helpers'
import type { DouyuWatchPlaybackReport } from '../server/douyu/watchTypes'

test('斗鱼观时状态经过真实IPC展示, 未登录和伪造房间参数不能触发官方观时', async ({ page, electronApp }, testInfo) => {
  await openPlayer(page)
  await connectDanmaku(page, '288016')
  await expect.poll(async () => await invoke(page, 'getDouyuWatchState', undefined)).toMatchObject({
    ok: true, value: { room: '288016', phase: 'login-required', verifiedIncrease: 0 },
  })
  const report: DouyuWatchPlaybackReport = { role: 'commentary', playing: true, currentTime: 1, decodedBytes: null, presentedFrames: null }
  expect(await invoke(page, 'reportDouyuWatchPlayback', { ...report, room: '9999' } as DouyuWatchPlaybackReport)).toMatchObject({ ok: false, code: 'invalid-arguments' })
  expect(await invoke(page, 'reportDouyuWatchPlayback', report)).toMatchObject({ ok: true, value: { verifiedIncrease: 0 } })
  const settings = await openSettingsSection(page, '房间数据')
  await expect(settings).toContainText('官方观时上报')
  await expect(settings).toContainText('粉丝牌累计观看')
  await expect(settings).toContainText('请先登录当前斗鱼账号.')
  const status = settings.getByRole('group', { name: '开播状态' })
  await expect(status).toContainText('直播或轮播状态未确认')
  for (const [live, replay, label] of [[true, false, '直播中'], [true, true, '轮播中'], [false, false, '未开播']] as const) {
    await electronApp.evaluate((_electron, flags) => {
      const host = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuRoomStatusFixture(room: string, live: boolean, replay: boolean): void } }
      host.__streamSyncerTest!.setDouyuRoomStatusFixture('288016', flags.live, flags.replay)
    }, { live, replay })
    await expect(status).toContainText(label)
  }
  await settings.screenshot({ path: testInfo.outputPath('douyu-watch-state.png') })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
})
