import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'

test('鱼吧登录入口和签到任务通过受限 IPC, 重启后保持暂停', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const running = await launchApplication('douyu-yuba')
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '9999': '9999' })
    })
    await openPlayer(running.page)
    const dialog = await openSourceDialog(running.page)
    const tools = dialog.getByRole('region', { name: '斗鱼账号和任务' })
    await tools.locator('summary').filter({ hasText: '管理斗鱼账号' }).click()
    const account = tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
    await account.getByRole('button', { name: '登录鱼吧', exact: true }).click()
    await expect(tools).toContainText('鱼吧登录窗口已关闭')
    await expect(account).toContainText('已登录')
    await tools.locator('summary').filter({ hasText: '签到任务' }).click()
    await tools.getByLabel('签到房间号或地址', { exact: true }).fill('9999')
    await tools.getByLabel('签到类型', { exact: true }).selectOption('yuba-sign')
    await tools.getByLabel('执行条件', { exact: true }).selectOption('background-locked')
    await tools.getByLabel('执行周期', { exact: true }).selectOption('daily')
    await tools.getByRole('button', { name: '创建签到任务', exact: true }).click()
    const task = tools.getByRole('group', { name: '鱼吧签到任务 9999 (默认账号)', exact: true })
    await expect(task).toContainText('已暂停')
    await tools.getByRole('checkbox', { name: '保留房间 9999 的任务' }).check()
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect(task).toContainText('离线鱼吧签到测试完成')
    const state = await invoke(running.page, 'getDouyuTasks', undefined)
    expect(state).toMatchObject({ ok: true, value: { tasks: [{ kind: 'yuba-sign', room: '9999', repeatMinutes: 1440, status: 'queued' }] } })
    if (!state.ok) throw new Error('Task snapshot unavailable')
    expect(state.value.tasks[0]?.nextRunAt).toBeGreaterThan(Date.now())

    await tools.getByLabel('签到类型', { exact: true }).selectOption('room-sign')
    await tools.getByRole('button', { name: '创建签到任务', exact: true }).click()
    await expect(tools.getByRole('group', { name: '签到任务 9999 (默认账号)', exact: true })).toContainText('已暂停')
    await task.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-yuba-tasks.png'), fullPage: true })

    await running.restart()
    const restored = await invoke(running.page, 'getDouyuTasks', undefined)
    expect(restored).toMatchObject({ ok: true, value: { retainedRooms: ['9999'], tasks: [
      { kind: 'yuba-sign', status: 'paused', nextRunAt: null, lastRunAt: null },
      { kind: 'room-sign', status: 'paused', nextRunAt: null, lastRunAt: null },
    ] } })
  } finally { await running.close() }
})
