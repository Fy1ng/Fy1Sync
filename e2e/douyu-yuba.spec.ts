import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openDouyuTab, openPlayerWithDouyuWrites, openTaskForm, setCheckedByLabel } from './helpers'

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
    await openPlayerWithDouyuWrites(running.page)
    const tools = await openDouyuTab(running.page, '账号')
    const account = tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
    await account.getByRole('button', { name: '登录鱼吧', exact: true }).click()
    await expect(tools).toContainText('鱼吧登录窗口已关闭')
    await expect(account).toContainText('已登录')
    const form = await openTaskForm(running.page, 'yuba-sign', '9999', true)
    await form.getByRole('button', { name: '添加', exact: true }).click()
    const task = tools.getByRole('group', { name: '鱼吧签到任务 9999 (默认账号)', exact: true })
    await expect(task).toHaveAttribute('data-status', 'paused')
    await setCheckedByLabel(tools.getByRole('region', { name: '任务房间 9999', exact: true }).getByRole('switch', { name: '离开该房间后继续', exact: true }))
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect(task).toContainText('离线鱼吧签到测试完成')
    const state = await invoke(running.page, 'getDouyuTasks', undefined)
    expect(state).toMatchObject({ ok: true, value: { tasks: [{ kind: 'yuba-sign', room: '9999', repeatMinutes: 1440, status: 'queued' }] } })
    if (!state.ok) throw new Error('Task snapshot unavailable')
    expect(state.value.tasks[0]?.nextRunAt).toBeGreaterThan(Date.now())

    const roomForm = await openTaskForm(running.page, 'room-sign', '9999', true)
    await roomForm.getByRole('button', { name: '添加', exact: true }).click()
    await expect(tools.getByRole('group', { name: '签到任务 9999 (默认账号)', exact: true })).toHaveAttribute('data-status', 'paused')
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
