import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { openDouyuTab, openPlayerWithDouyuWrites, setCheckedByLabel } from './helpers'

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
    await setFixture(3, 'receipt-received')
    await openPlayerWithDouyuWrites(running.page)
    const tools = await openDouyuTab(running.page, '账号')
    const account = tools.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
    await account.getByRole('button', { name: '登录', exact: true }).click()
    await expect(account).toContainText('已登录')
    await openDouyuTab(running.page, '粉丝牌')
    await tools.getByRole('button', { name: '读取 默认账号 的粉丝牌', exact: true }).click()
    await tools.getByRole('searchbox', { name: '筛选粉丝牌', exact: true }).fill('6979222')
    await expect(tools.locator('.badges').getByRole('checkbox')).toHaveCount(1)
    await tools.locator('.badges').getByRole('checkbox').check()
    await expect(tools).toContainText('1/20')
    await tools.getByRole('searchbox', { name: '筛选粉丝牌', exact: true }).fill('')
    for (const checkbox of await tools.locator('.badges').getByRole('checkbox').all()) await checkbox.check()
    await setCheckedByLabel(tools.getByRole('radiogroup', { name: '数量分配方式', exact: true }).getByRole('radio', { name: '逐房数量', exact: true }))
    await tools.getByRole('spinbutton', { name: '房间 6979222 的赠送数量', exact: true }).fill('2')
    const generate = tools.getByRole('button', { name: /^(生成核对单|重新生成)$/ })
    const confirm = tools.getByRole('button', { name: '确认赠送', exact: true })
    await generate.click()
    const preview = tools.getByRole('region', { name: '赠送预览', exact: true })
    await expect(preview).toContainText(/用\s*3\s*个背包道具，送给\s*2\s*个房间/)
    await expect(preview).toContainText('离线测试荧光棒')
    expect(await donations()).toEqual([])
    await preview.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('renewal-preview.png'), fullPage: true })
    await focus()
    await confirm.click()
    const result = tools.getByRole('region', { name: '赠送处理结果', exact: true })
    await expect(result).toContainText('处理完成')
    await expect(result.locator('li[data-state="receipt-received"]')).toHaveCount(2)
    await expect(result).not.toContainText('续牌成功')
    expect(await donations()).toEqual([
      { accountId: 'default', room: '6979222', propId: '268', quantity: 2 },
      { accountId: 'default', room: '288016', propId: '268', quantity: 1 },
    ])
    await expect(confirm).toBeDisabled()

    await setFixture(4, 'unknown')
    await generate.click()
    await expect(confirm).toBeEnabled()
    await focus()
    await confirm.click()
    await expect(result.locator('li[data-state="unknown"]')).toHaveCount(1)
    await expect(result.locator('li[data-state="not-submitted"]')).toHaveCount(1)
    expect(await donations()).toHaveLength(1)
    await result.scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('renewal-unconfirmed.png'), fullPage: true })

    await setFixture(4, 'receipt-received')
    await generate.click()
    await expect(preview).toContainText('库存 4')
    await setFixture(1, 'receipt-received')
    await focus()
    await confirm.click()
    await expect(result).toContainText('库存已变化')
    expect(await donations()).toEqual([])
  } finally { await running.close() }
})
