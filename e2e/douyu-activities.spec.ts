import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'

test('钓鱼, 红包和宝箱共享任务调度, 人工验证入口及重启暂停', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const app = await launchApplication('douyu-activities')
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
    const tools = (await openSourceDialog(app.page)).getByRole('region', { name: '斗鱼账号和任务' })
    await tools.getByRole('button', { name: '登录斗鱼', exact: true }).click()
    await expect(tools).toContainText('默认账号 已登录')
    await tools.locator('summary').filter({ hasText: '房间任务' }).click()
    await tools.getByLabel('任务房间号或地址', { exact: true }).fill('9999')
    await tools.getByLabel('执行条件', { exact: true }).selectOption('background-locked')
    for (const kind of ['auto-fish', 'gift-packet', 'treasure-box']) {
      await tools.getByLabel('任务类型', { exact: true }).selectOption(kind)
      await expect(tools.getByLabel('执行周期', { exact: true })).toHaveCount(0)
      await tools.getByRole('button', { name: '创建活动任务', exact: true }).click()
      await expect(tools).toContainText('活动任务已创建, 当前为暂停.')
    }
    const fishing = tools.getByRole('group', { name: '自动钓鱼任务 9999 (默认账号)', exact: true })
    const packet = tools.getByRole('group', { name: '礼物红包任务 9999 (默认账号)', exact: true })
    const chest = tools.getByRole('group', { name: '半自动宝箱任务 9999 (默认账号)', exact: true })
    await expect(fishing).toContainText('已暂停')
    await tools.getByRole('checkbox', { name: '保留房间 9999 的任务' }).check()
    await fishing.getByRole('button', { name: '启动', exact: true }).click()
    await expect(fishing).toContainText('等待官方时间')
    await packet.getByRole('button', { name: '启动', exact: true }).click()
    await expect(packet).toContainText('等待官方时间')
    await app.application.evaluate(() => {
      (globalThis as typeof globalThis & { __streamSyncerTest: { setDouyuActivityFixtureOutcome(value: string): void } })
        .__streamSyncerTest.setDouyuActivityFixtureOutcome('waiting-user')
    })
    await chest.getByRole('button', { name: '启动', exact: true }).click()
    await expect(chest).toContainText('请完成人工验证')
    await expect(chest).toContainText('等待手动处理')
    await chest.getByRole('button', { name: '打开官方房间', exact: true }).click()
    await expect(tools).toContainText('官方页面窗口已关闭')
    for (const row of [fishing, packet, chest]) await expect(row).toContainText('已暂停')
    const fixture = await app.application.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { getDouyuActivitiesFixture(): { attempts: unknown[]; rooms: string[] } } })
        .__streamSyncerTest.getDouyuActivitiesFixture())
    expect(fixture.attempts).toEqual([
      { accountId: 'default', room: '9999', kind: 'auto-fish' },
      { accountId: 'default', room: '9999', kind: 'gift-packet' },
      { accountId: 'default', room: '9999', kind: 'treasure-box' },
    ])
    expect(fixture.rooms).toEqual(['room:9999'])
    await fishing.getByRole('button', { name: '打开官方钓鱼', exact: true }).click()
    await expect(tools).toContainText('官方页面窗口已关闭')
    const afterFishPage = await app.application.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { getDouyuActivitiesFixture(): { rooms: string[] } } })
        .__streamSyncerTest.getDouyuActivitiesFixture())
    expect(afterFishPage.rooms).toEqual(['room:9999', 'fish-act:9999'])
    await app.application.evaluate(() => {
      (globalThis as typeof globalThis & { __streamSyncerTest: { setDouyuActivityFixtureOutcome(value: string): void } })
        .__streamSyncerTest.setDouyuActivityFixtureOutcome('succeeded')
    })
    await chest.getByRole('button', { name: '启动', exact: true }).click()
    await expect(chest).toContainText('离线活动测试完成')
    await chest.scrollIntoViewIfNeeded()
    await app.page.screenshot({ path: testInfo.outputPath('douyu-activities.png'), fullPage: true })
    await app.restart()
    expect(await invoke(app.page, 'getDouyuTasks', undefined)).toMatchObject({ ok: true, value: {
      retainedRooms: ['9999'], tasks: [
        { kind: 'auto-fish', status: 'paused', nextRunAt: null },
        { kind: 'gift-packet', status: 'paused', nextRunAt: null },
        { kind: 'treasure-box', status: 'paused', nextRunAt: null },
      ],
    } })
  } finally { await app.close() }
})
