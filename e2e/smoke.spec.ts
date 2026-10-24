/** Built desktop app smoke checks: the real shell, preload IPC and scheme guards. */

import { APP_ORIGIN, expect, test } from './electron'
import type { RecognitionProfile } from '../src/core/profileSchema'
import { failOnPageError, invoke, openPlayer, sourceDialog } from './helpers'

test.describe('应用外壳', () => {
  test('冷启动渲染播放页并打开片源对话框', async ({ page }) => {
    failOnPageError(page)
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await page.goto(APP_ORIGIN + '/')

    await expect(page.locator('.player-page')).toBeVisible()
    // Nothing is loaded yet, so the dialog is the cold-start entry point.
    await expect(sourceDialog(page)).toBeVisible()
    await expect(page.locator('.stage-main')).toHaveAttribute('data-role', 'official')

    // Both elements exist before any source is chosen: they are owned by MediaEngine, not
    // created per load. That is what lets a swap keep the buffer.
    await expect(page.locator('video.media-element')).toHaveCount(2)

    expect(consoleErrors, `控制台不应有错误：${consoleErrors.join(' | ')}`).toEqual([])
  })

  test('侧栏可收起并在重新加载后展开', async ({ page }) => {
    await openPlayer(page)

    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar').getByRole('button', { name: '收起' }).click()
    await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.locator('.player-page')).toHaveClass(/no-sidebar/)

    // Settings are persisted, so a reload must not bring it back.
    await page.reload()
    await expect(page.locator('.player-page')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeHidden()
    await sourceDialog(page).getByRole('button', { name: '完成' }).click()
    await page.getByRole('button', { name: '展开侧栏' }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.reload()
    await expect(page.locator('.sidebar')).toBeVisible()
  })

  test('真实全屏保留可操作的片源对话框', async ({ page }, testInfo) => {
    await openPlayer(page)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('player-page') ?? false)).toBe(true)
    await expect(page.locator('.sidebar')).toBeHidden()
    await page.getByRole('button', { name: '片源设置', exact: true }).click()
    await expect(sourceDialog(page)).toBeVisible()
    expect(await sourceDialog(page).evaluate(node => document.fullscreenElement?.contains(node))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('fullscreen-source-dialog.png') })
    await sourceDialog(page).getByRole('button', { name: '完成' }).click()
    await page.getByRole('button', { name: '退出全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
    await expect(page.locator('.sidebar')).toBeVisible()
  })

  test('未加载片源时同步状态显示为零', async ({ page }) => {
    await openPlayer(page)
    const sidebar = page.locator('.sidebar')
    await expect(sidebar.locator('.status-pill')).toBeVisible()
    await expect(sidebar.locator('.sync-headroom')).toContainText('未加载')
  })
})

test.describe('主进程接口与安全边界', () => {
  test('health IPC 报告运行状态且渲染进程没有 Node 权限', async ({ page }) => {
    const response = await invoke(page, 'health', undefined)
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.message)
    expect(response.value.ok).toBe(true)
    expect(await page.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>).require,
      process: typeof (window as unknown as Record<string, unknown>).process,
    }))).toEqual({ require: 'undefined', process: 'undefined' })
  })

  test('resolve IPC 对无法解析的输入返回结构化失败', async ({ page }) => {
    const response = await invoke(page, 'resolve', { input: 'not-a-stream-at-all' })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.message)
    expect(response.value.ok).toBe(false)
    if (response.value.ok) throw new Error('Unresolvable input was unexpectedly accepted')
    expect(response.value.failure.message).toBeTruthy()
  })

  test('本机写入仍需通过主进程预设校验', async ({ page }) => {
    const verified = await invoke(page, 'verifyAdmin', { token: '' })
    expect(verified).toEqual({ ok: true, value: { ok: true } })
    const rejected = await invoke(page, 'savePreset', {
      id: 'smoke-should-fail',
      profile: { schemaVersion: 2, id: 'smoke-should-fail' } as RecognitionProfile,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('Invalid profile was unexpectedly accepted')
    expect(rejected.code).toBe('invalid-profile')
    expect(rejected.detail).toHaveProperty('issues')
    const stored = await invoke(page, 'getPreset', { id: 'smoke-should-fail' })
    expect(stored.ok).toBe(false)
  })

  test('媒体路径拒绝内网目标和未登记标识', async ({ page }) => {
    const response = await invoke(page, 'resolve', {
      input: 'http://127.0.0.1:9/secret', platform: 'direct',
    })
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('Private media target was unexpectedly accepted')
    expect(['private-address', 'bad-port', 'host-not-allowed']).toContain(response.code)
    expect(response.message).toBeTruthy()

    const status = await page.evaluate(async () =>
      (await fetch('app://app/media/unregistered?url=http://127.0.0.1:9/secret')).status,
    )
    expect(status).toBeGreaterThanOrEqual(400)
    expect(status).toBeLessThan(500)
  })

  test('未知 IPC 方法被拒绝且旧 API 地址不会落到页面', async ({ page }) => {
    const rejected = await page.evaluate(async () => {
      const invokeUnknown = window.streamSyncer?.invoke as unknown as
        (method: string, args: undefined) => Promise<{ ok: boolean; code?: string }>
      return invokeUnknown('definitely-not-a-method', undefined)
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe('unknown-method')
    const status = await page.evaluate(async () => (await fetch('app://app/api/definitely-not-a-route')).status)
    expect(status).toBe(404)
  })
})
