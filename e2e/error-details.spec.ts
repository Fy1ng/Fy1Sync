import { expect, test } from './electron'
import { openSettings, openSettingsSection } from './helpers'

test('本地输入校验只提示如何修正，不提供原始错误', async ({ page }) => {
  const settings = await openSettingsSection(page, '弹幕记录')
  await settings.getByRole('tablist', { name: '弹幕记录', exact: true }).getByRole('tab', { name: '历史', exact: true }).click()
  await settings.getByRole('textbox', { name: '用户 ID' }).fill('abc')
  await settings.getByRole('button', { name: '搜索', exact: true }).click()
  const validation = settings.getByRole('alert').filter({ hasText: '用户 ID 须为数字' })
  await expect(validation).toBeVisible()
  await expect(validation.getByRole('button', { name: '查看原始错误' })).toHaveCount(0)
})

test('赛程 HTTP 错误通过真实 IPC 展开并复制原始字段', async ({ electronApp, page }, testInfo) => {
  await page.getByRole('button', { name: /^CS2 赛程/ }).click()
  const sheet = page.getByRole('dialog', { name: '赛程', exact: true })
  await expect(sheet.getByRole('button', { name: '查看原始错误' })).toBeVisible()
  await electronApp.evaluate(async ({ app }) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const path = process.getBuiltinModule('node:path')
    const root = path.resolve(process.env.STREAM_SYNC_E2E_DATA_ROOT || path.join(process.cwd(), 'e2e', '.data'))
    const profile = path.resolve(app.getPath('userData'))
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1' || !profile.startsWith(root + path.sep)) throw new Error('Disposable offline profile required')
    const directory = path.join(profile, 'events')
    await fs.mkdir(directory, { recursive: true })
    const now = Date.now()
    // Historical match outside the -12h/+48h window keeps the empty-window layout while recording fetchedAt.
    await fs.writeFile(path.join(directory, 'relay-schedule.json'), JSON.stringify({
      origin: 'https://schedule.fy1ng.cn',
      receivedAt: now,
      etag: '"error-detail-fixture"',
      schedule: {
        schema: 1,
        fetchedAt: now,
        generatedAt: now,
        source: 'liquipedia',
        attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）',
        upstream: { limitedUntil: null },
        matches: [],
      },
    }))
    const original = globalThis.fetch
    const counter = globalThis as typeof globalThis & { __errorDetailRequests?: number }
    counter.__errorDetailRequests = 0
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname !== 'schedule.fy1ng.cn') return original(input, init)
      counter.__errorDetailRequests!++
      return new Response('<title>Service Unavailable</title><input name="token" value="PRIVATE_TEST_TOKEN">',
        { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'text/html', 'retry-after': '60' } })
    }
  })
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: /^CS2 赛程/ }).click()
  await sheet.getByRole('button', { name: '刷新', exact: true }).click()
  await expect.poll(() => electronApp.evaluate(() => (globalThis as typeof globalThis & { __errorDetailRequests?: number }).__errorDetailRequests)).toBe(1)
  await expect(sheet).toContainText('赛程服务正在维护或同步中（HTTP 503），请稍后重试')
  await expect(sheet.getByRole('button', { name: '刷新', exact: true })).toBeEnabled()
  await sheet.getByRole('button', { name: '查看原始错误' }).click()
  const panel = sheet.getByRole('region', { name: '原始错误信息' })
  await expect(panel).toContainText('503')
  await expect(panel).toContainText('Service Unavailable')
  await expect(panel).toContainText('retryAfter')
  await expect(panel).not.toContainText('PRIVATE_TEST_TOKEN')
  await expect(sheet).toContainText('读取于')
  const layout = await sheet.locator('.sched-empty-content').evaluate(node => ({
    top: node.getBoundingClientRect().top,
    buttonTop: node.querySelector('.error-details-toggle')!.getBoundingClientRect().top,
  }))
  expect(layout.buttonTop - layout.top).toBeLessThan(40)
  await page.evaluate(() => {
    const state = window as typeof window & { __copiedError?: string }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { state.__copiedError = text } } })
  })
  await panel.getByRole('button', { name: '复制错误信息' }).click()
  await expect(panel.getByRole('button', { name: '已复制' })).toBeVisible()
  expect(await page.evaluate(() => (window as typeof window & { __copiedError?: string }).__copiedError)).toContain('503')
  await page.screenshot({ path: testInfo.outputPath('schedule-error-details.png') })
  await sheet.getByRole('button', { name: '收起原始错误' }).click()
  await expect(panel).toBeHidden()
})

test('工具更新失败可查看原始异常且保留普通提示', async ({ electronApp, page }, testInfo) => {
  await electronApp.evaluate(() => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Offline test required')
    const hook = (globalThis as typeof globalThis & { __streamSyncerTest: { setToolUpdateFixture(bytes: Uint8Array, outcome: 'network-error'): void } }).__streamSyncerTest
    hook.setToolUpdateFixture(new Uint8Array([1]), 'network-error')
  })
  const settings = await openSettings(page, '取流工具')
  const section = settings.getByRole('region', { name: '取流工具' })
  const update = section.getByRole('button', { name: '更新 yt-dlp', exact: true })
  await expect(update).toBeEnabled()
  await update.click()
  await expect(section).toContainText('下载失败，请检查网络后重试')
  await section.getByRole('button', { name: '查看原始错误' }).click()
  const panel = section.getByRole('region', { name: '原始错误信息' })
  await expect(panel).toContainText('Offline fixture network failure')
  await expect(panel).toContainText('network')
  await page.screenshot({ path: testInfo.outputPath('tool-error-details.png') })
})
