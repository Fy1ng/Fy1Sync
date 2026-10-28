import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openDouyuTab, openPlayerWithDouyuWrites, openTaskForm, setCheckedByLabel } from './helpers'

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
    await openPlayerWithDouyuWrites(app.page)
    const tools = await openDouyuTab(app.page, '账号')
    await tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true }).getByRole('button', { name: '登录', exact: true }).click()
    await expect(tools).toContainText('默认账号 已登录')
    for (const kind of ['auto-fish', 'gift-packet', 'treasure-box'] as const) {
      const form = await openTaskForm(app.page, kind, '9999')
      await expect(form.getByRole('switch', { name: '每天签到一次', exact: true })).toHaveCount(0)
      await form.getByRole('button', { name: '添加', exact: true }).click()
      await expect(tools).toContainText('已添加，点击「启动」开始运行')
    }
    const fishing = tools.getByRole('group', { name: '钓鱼任务 9999 (默认账号)', exact: true })
    const packet = tools.getByRole('group', { name: '抢红包任务 9999 (默认账号)', exact: true })
    const chest = tools.getByRole('group', { name: '开宝箱任务 9999 (默认账号)', exact: true })
    await expect(fishing).toHaveAttribute('data-status', 'paused')
    await setCheckedByLabel(tools.getByRole('region', { name: '任务房间 9999', exact: true }).getByRole('switch', { name: '离开该房间后继续', exact: true }))
    await fishing.getByRole('button', { name: '启动', exact: true }).click()
    await expect(fishing).toHaveAttribute('data-status', 'queued')
    await packet.getByRole('button', { name: '启动', exact: true }).click()
    await expect(packet).toHaveAttribute('data-status', 'queued')
    await expect.poll(async () => {
      const state = await invoke(app.page, 'getDouyuTasks', undefined)
      return state.ok ? state.value.tasks.slice(0, 2).map(task => task.lastResult) : []
    }).toEqual(['离线活动状态: 等待官方时间', '离线活动状态: 等待官方时间'])
    await app.application.evaluate(() => {
      (globalThis as typeof globalThis & { __streamSyncerTest: { setDouyuActivityFixtureOutcome(value: string): void } })
        .__streamSyncerTest.setDouyuActivityFixtureOutcome('waiting-user')
    })
    await chest.getByRole('button', { name: '启动', exact: true }).click()
    await expect(chest).toContainText('请完成人工验证')
    await expect(chest).toHaveAttribute('data-status', 'waiting-user')
    await chest.getByRole('button', { name: '打开官方页面', exact: true }).click()
    for (const row of [fishing, packet, chest]) await expect(row).toHaveAttribute('data-status', 'paused')
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
    await expect.poll(async () => (await invoke(app.page, 'getDouyuTasks', undefined))).toMatchObject({ ok: true, value: { tasks: [
      { status: 'paused' }, { status: 'paused' }, { status: 'paused' },
    ] } })
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
