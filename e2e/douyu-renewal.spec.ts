import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { openPlayer, openSourceDialog } from './helpers'

test('续牌赠送先预览再确认, 库存变化与未知回执停止余下操作', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const running = await launchApplication('douyu-renewal')
  const donations = () => running.application.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
      getDouyuRenewalDonationsFixture(): Array<{ accountId: string; room: string; propId: string; quantity: number }>
    } }
    return main.__streamSyncerTest!.getDouyuRenewalDonationsFixture()
  })
  const setFixture = (stock: number, outcome: 'receipt-received' | 'unknown') => running.application.evaluate((_electron, value) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest?: { setDouyuRenewalFixture(stock: number, outcome: 'receipt-received' | 'unknown'): void } }
    main.__streamSyncerTest!.setDouyuRenewalFixture(value.stock, value.outcome)
  }, { stock, outcome })
  const focus = () => running.application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })
  try {
    await running.application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __streamSyncerTest?: {
        setDouyuToolsFixture(): void
        setDouyuRoomFixture(mapping: Record<string, string>): void
      } }
      main.__streamSyncerTest!.setDouyuToolsFixture()
      main.__streamSyncerTest!.setDouyuRoomFixture({ '6979222': '6979222', '288016': '288016' })
    })
    await setFixture(2, 'receipt-received')
    await openPlayer(running.page)
    const dialog = await openSourceDialog(running.page)
    const tools = dialog.getByRole('region', { name: '斗鱼账号和任务' })
    await tools.getByRole('button', { name: '登录斗鱼', exact: true }).click()
    await expect(tools).toContainText('活动账号: 默认账号, 已登录')
    await tools.locator('summary').filter({ hasText: '续牌赠送' }).click()
    await tools.getByRole('button', { name: '读取粉丝牌', exact: true }).click()
    await tools.getByRole('button', { name: '全选本页', exact: true }).click()
    await tools.getByRole('button', { name: '生成赠送预览', exact: true }).click()
    const preview = tools.getByRole('region', { name: '赠送预览', exact: true })
    await expect(preview).toContainText('计划使用 2 个现有背包道具, 赠送至 2 个房间')
    await expect(preview).toContainText('离线测试荧光棒')
    expect(await donations()).toEqual([])
    await preview.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('renewal-preview.png'), fullPage: true })
    await focus()
    await preview.getByRole('button', { name: '确认赠送', exact: true }).click()
    const result = tools.getByRole('region', { name: '赠送处理结果', exact: true })
    await expect(result).toContainText('赠送处理完成')
    await expect(result.locator('li[data-state="receipt-received"]')).toHaveCount(2)
    await expect(result).not.toContainText('续牌成功')
    expect(await donations()).toEqual([
      { accountId: 'default', room: '6979222', propId: '268', quantity: 1 },
      { accountId: 'default', room: '288016', propId: '268', quantity: 1 },
    ])
    await expect(preview.getByRole('button', { name: '确认赠送', exact: true })).toBeDisabled()

    await setFixture(4, 'unknown')
    await tools.getByRole('button', { name: '生成赠送预览', exact: true }).click()
    await expect(preview.getByRole('button', { name: '确认赠送', exact: true })).toBeEnabled()
    await focus()
    await preview.getByRole('button', { name: '确认赠送', exact: true }).click()
    await expect(result.locator('li[data-state="unknown"]')).toHaveCount(1)
    await expect(result.locator('li[data-state="not-submitted"]')).toHaveCount(1)
    expect(await donations()).toHaveLength(1)
    await result.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('renewal-unconfirmed.png'), fullPage: true })

    await setFixture(4, 'receipt-received')
    await tools.getByRole('button', { name: '生成赠送预览', exact: true }).click()
    await expect(preview).toContainText('读取时库存 4')
    await setFixture(1, 'receipt-received')
    await focus()
    await preview.getByRole('button', { name: '确认赠送', exact: true }).click()
    await expect(result).toContainText('库存已变化')
    expect(await donations()).toEqual([])
  } finally { await running.close() }
})
