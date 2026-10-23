import { mkdir } from 'node:fs/promises'
import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'
import type { DouyuTasksSnapshot } from '../server/douyu/types'
import type { Page } from '@playwright/test'

async function tasks(page: Page): Promise<DouyuTasksSnapshot> {
  const result = await invoke(page, 'getDouyuTasks', undefined)
  if (!result.ok) throw new Error('Task snapshot unavailable')
  return result.value
}

test('斗鱼账号隔离, 任务控制和重启暂停经过实际 Electron 界面', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const running = await launchApplication('douyu-tools')
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222', '6979222': '6979222', '288016': '288016' })
    })
    await openPlayer(running.page)
    const dialog = await openSourceDialog(running.page)
    const tools = dialog.getByRole('region', { name: '斗鱼账号和任务' })
    await expect(tools).toContainText('活动账号: 默认账号')
    await tools.locator('summary').filter({ hasText: '管理斗鱼账号' }).click()
    await tools.getByLabel('斗鱼账号标签', { exact: true }).fill('测试账号')
    await tools.getByRole('button', { name: '新增账号', exact: true }).click()
    const added = tools.getByRole('group', { name: '斗鱼账号 测试账号', exact: true })
    await expect(added).toBeVisible()
    await added.getByRole('button', { name: '激活', exact: true }).click()
    await expect(added).toContainText('当前活动')
    await added.getByRole('button', { name: '登录', exact: true }).click()
    await expect(added).toContainText('已登录')
    await expect(tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })).toContainText('未登录')

    await dialog.getByRole('textbox', { name: '弹幕房间号', exact: true }).fill('6657')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('6979222')
    await tools.locator('summary').filter({ hasText: '房间任务' }).click()
    await tools.getByLabel('任务房间号或地址', { exact: true }).fill('6657')
    await tools.getByLabel('执行条件', { exact: true }).selectOption('background-locked')
    await tools.getByLabel('执行周期', { exact: true }).selectOption('daily')
    await tools.getByRole('button', { name: '创建签到任务', exact: true }).click()
    const task = tools.getByRole('group', { name: '签到任务 6979222 (测试账号)', exact: true })
    await expect(task).toContainText('已暂停')
    expect((await tasks(running.page)).tasks[0]).toMatchObject({ room: '6979222', policy: 'background-locked', repeatMinutes: 1440, lastRunAt: null })
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect(task).toContainText('离线签到测试完成')
    expect((await tasks(running.page)).tasks[0]?.nextRunAt).toBeGreaterThan(Date.now())

    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        emitDanmaku(room: string, event: string, data: unknown): number
      } }
      main.__streamSyncerTest!.emitDanmaku('6979222', 'state', { room: '6979222', state: 'connected' })
    })
    await dialog.getByRole('button', { name: '断开', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBeNull()
    await expect(task).toContainText('已停止')
    expect((await tasks(running.page)).tasks[0]?.nextRunAt).toBeNull()
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('6979222')
    await expect(task).toContainText('已停止')
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()

    await tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true }).getByRole('button', { name: '激活', exact: true }).click()
    await expect(task).toContainText('已暂停')
    await added.getByRole('button', { name: '激活', exact: true }).click()
    await expect(task).toContainText('已暂停')
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()
    await tools.getByRole('checkbox', { name: '保留房间 6979222 的任务' }).check()
    await dialog.getByRole('textbox', { name: '弹幕房间号', exact: true }).fill('288016')
    await dialog.getByRole('button', { name: '连接', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('288016')
    expect((await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()
    await tools.getByRole('region', { name: '任务房间 6979222', exact: true }).getByRole('button', { name: '关闭保留房间', exact: true }).click()
    await expect(task).toContainText('已停止')

    await mkdir(testInfo.outputDir, { recursive: true })
    await tools.locator('summary').filter({ hasText: '管理斗鱼账号' }).scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-accounts.png'), fullPage: true })
    await task.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-task.png'), fullPage: true })

    await running.restart()
    await openPlayer(running.page)
    const reopened = await openSourceDialog(running.page)
    await expect(reopened.getByRole('region', { name: '斗鱼账号和任务' })).toContainText('活动账号: 测试账号')
    const restored = await tasks(running.page)
    expect(restored.tasks).toHaveLength(1)
    expect(restored.tasks[0]).toMatchObject({ status: 'paused', nextRunAt: null, lastRunAt: null })
    expect(restored.retainedRooms).toEqual([])
    const accountState = await invoke(running.page, 'listDouyuAccounts', undefined)
    expect(accountState).toMatchObject({ ok: true, value: { accounts: [
      { id: 'default', active: false, login: { loggedIn: false } },
      { label: '测试账号', active: true, login: { loggedIn: true } },
    ] } })
  } finally { await running.close() }
})
