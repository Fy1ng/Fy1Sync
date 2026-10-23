import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSourceDialog } from './helpers'
import type { DouyuMessageInput, DouyuTaskView } from '../server/douyu/types'

test('延迟循环发送按次数和颜色执行, 未知结果停止, 重启保留配置并暂停', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const running = await launchApplication('douyu-message-tasks')
  const sent = () => running.application.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { getDouyuSentFixture(): DouyuMessageInput[] } }
    return main.__streamSyncerTest!.getDouyuSentFixture()
  })
  const current = async (): Promise<DouyuTaskView | undefined> => {
    const state = await invoke(running.page, 'getDouyuTasks', undefined)
    if (!state.ok) throw new Error('Task state unavailable')
    return state.value.tasks[0]
  }
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '6657': '6979222' })
    })
    await openPlayer(running.page)
    expect(await invoke(running.page, 'loginDouyuAccount', { id: 'default' })).toMatchObject({ ok: true })
    const dialog = await openSourceDialog(running.page)
    const tools = dialog.getByRole('region', { name: '斗鱼账号和任务' })
    await tools.locator('summary').filter({ hasText: '房间任务' }).click()
    await tools.getByLabel('任务房间号或地址', { exact: true }).fill('6657')
    await tools.getByLabel('任务类型', { exact: true }).selectOption('message-loop')
    await tools.getByLabel('执行条件', { exact: true }).selectOption('background-locked')
    await tools.getByLabel('发送内容', { exact: true }).fill('离线循环提醒 @/')
    await tools.getByLabel('发送间隔(秒)', { exact: true }).fill('1')
    await tools.getByLabel('启动延迟(秒)', { exact: true }).fill('1')
    await tools.getByLabel('发送次数', { exact: true }).fill('3')
    await tools.getByLabel('发送颜色 蓝色', { exact: true }).check()
    await tools.getByRole('button', { name: '创建发送任务', exact: true }).click()
    const row = tools.getByRole('group', { name: '发送任务 6979222 (默认账号)', exact: true })
    await expect(row).toContainText('已暂停')
    expect(await current()).toMatchObject({ kind: 'message-loop', completedRuns: 0, lastRunAt: null,
      message: { text: '离线循环提醒 @/', colors: [0, 2], intervalSeconds: 1, initialDelaySeconds: 1, maxRuns: 3 } })
    expect(await sent()).toHaveLength(0)
    await tools.getByRole('checkbox', { name: '保留房间 6979222 的任务', exact: true }).check()
    await row.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await current())?.status).toBe('succeeded')
    await expect(row).toContainText('本轮已确认 3 次 / 共 3 次')
    expect((await sent()).map(value => ({ room: value.room, color: value.color, text: value.text }))).toEqual([
      { room: '6979222', color: 0, text: '离线循环提醒 @/' },
      { room: '6979222', color: 2, text: '离线循环提醒 @/' },
      { room: '6979222', color: 0, text: '离线循环提醒 @/' },
    ])
    expect((await current())?.nextRunAt).toBeNull()
    await running.page.waitForTimeout(1200)
    expect(await sent()).toHaveLength(3)
    await row.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('message-task-completed.png'), fullPage: true })

    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuSendFixtureOutcome(value: 'waiting-user'): void } }
      main.__streamSyncerTest!.setDouyuSendFixtureOutcome('waiting-user')
    })
    await row.getByRole('button', { name: '启动', exact: true }).click()
    await expect.poll(async () => (await current())?.status).toBe('waiting-user')
    expect(await current()).toMatchObject({ completedRuns: 0, nextRunAt: null })
    await expect(row).toContainText('离线发送结果待核对')
    await running.page.waitForTimeout(1200)
    expect(await sent()).toHaveLength(4)

    await running.restart()
    expect(await current()).toMatchObject({ kind: 'message-loop', status: 'paused', completedRuns: 0, nextRunAt: null, lastRunAt: null,
      message: { text: '离线循环提醒 @/', colors: [0, 2], intervalSeconds: 1, initialDelaySeconds: 1, maxRuns: 3 } })
  } finally { await running.close() }
})
