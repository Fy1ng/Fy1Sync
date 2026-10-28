import { mkdir } from 'node:fs/promises'
import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { connectDanmaku, disconnectDanmaku, invoke, openDouyuTab, openPlayerWithDouyuWrites, openTaskForm, setCheckedByLabel } from './helpers'
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
    await openPlayerWithDouyuWrites(running.page)
    const tools = await openDouyuTab(running.page, '账号')
    await expect(tools.locator('.desk-who')).toContainText('默认账号')
    await tools.getByLabel('新账号名称', { exact: true }).fill('测试账号')
    await tools.getByRole('button', { name: '添加账号', exact: true }).click()
    const added = tools.getByRole('group', { name: '斗鱼账号 测试账号', exact: true })
    await expect(added).toBeVisible()
    await added.getByRole('button', { name: '设为当前', exact: true }).click()
    await expect(added).toContainText('当前使用')
    await added.getByRole('button', { name: '登录', exact: true }).click()
    await expect(added).toContainText('已登录')
    await expect(tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })).toContainText('未登录')

    await tools.getByRole('button', { name: '关闭', exact: true }).click()
    await connectDanmaku(running.page, '6657')
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('6979222')
    const form = await openTaskForm(running.page, 'room-sign', '6657', true)
    await form.getByRole('button', { name: '添加', exact: true }).click()
    const task = tools.getByRole('group', { name: '签到任务 6979222 (测试账号)', exact: true })
    await expect(task).toHaveAttribute('data-status', 'paused')
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
    await tools.getByRole('button', { name: '关闭', exact: true }).click()
    await disconnectDanmaku(running.page)
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBeNull()
    await openDouyuTab(running.page, '房间任务')
    await expect(task).toContainText('已停止')
    expect((await tasks(running.page)).tasks[0]?.nextRunAt).toBeNull()
    await tools.getByRole('button', { name: '关闭', exact: true }).click()
    await connectDanmaku(running.page, '6657')
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('6979222')
    await openDouyuTab(running.page, '房间任务')
    await expect(task).toContainText('已停止')
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()

    await openDouyuTab(running.page, '账号')
    await tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true }).getByRole('button', { name: '设为当前', exact: true }).click()
    await openDouyuTab(running.page, '房间任务')
    await expect(task).toHaveAttribute('data-status', 'paused')
    await openDouyuTab(running.page, '账号')
    await added.getByRole('button', { name: '设为当前', exact: true }).click()
    await openDouyuTab(running.page, '房间任务')
    await expect(task).toHaveAttribute('data-status', 'paused')
    await task.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()
    const retainedRoom = tools.getByRole('region', { name: '任务房间 6979222', exact: true })
    await setCheckedByLabel(retainedRoom.getByRole('switch', { name: '离开该房间后继续', exact: true }))
    await tools.getByRole('button', { name: '关闭', exact: true }).click()
    await connectDanmaku(running.page, '288016')
    await expect.poll(async () => (await tasks(running.page)).currentRoom).toBe('288016')
    expect((await tasks(running.page)).tasks[0]?.nextRunAt).not.toBeNull()
    await openDouyuTab(running.page, '房间任务')
    await setCheckedByLabel(retainedRoom.getByRole('switch', { name: '离开该房间后继续', exact: true }), false)
    await expect(task).toContainText('已停止')

    await mkdir(testInfo.outputDir, { recursive: true })
    await openDouyuTab(running.page, '账号')
    await running.page.screenshot({ path: testInfo.outputPath('douyu-accounts.png'), fullPage: true })
    await openDouyuTab(running.page, '房间任务')
    await task.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('douyu-task.png'), fullPage: true })

    await running.restart()
    await openPlayerWithDouyuWrites(running.page)
    const reopened = await openDouyuTab(running.page, '账号')
    await expect(reopened.locator('.desk-who')).toContainText('测试账号')
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
