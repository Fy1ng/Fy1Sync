/** Built desktop app smoke checks: the real shell, preload IPC and scheme guards. */

import { APP_ORIGIN, expect, test, visibleE2eWindows } from './electron'
import type { HudStylePack } from '../src/core/hudStylePack'
import { closeSourceDialog, connectDanmaku, failOnPageError, invoke, loadBothFixtures, offsetReadout, openPlayer, openSourceDialog, revealOverlay, sourceDialog } from './helpers'

test.describe('应用外壳', () => {
  test('Fy1Sync 标题栏按平台显示窗口按钮, 全屏隐藏标题栏', async ({ page, electronApp }, testInfo) => {
    test.skip(!visibleE2eWindows, '需要可见原生窗口验证最大化, 最小化和真实 HTML 全屏; 设置 STREAM_SYNC_E2E_VISIBLE=1')
    await openPlayer(page)
    await expect(page.locator('.titlebar-name')).toHaveText('Fy1Sync')
    expect(await page.locator('.titlebar').evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('drag')
    expect(await page.evaluate(() => window.streamSyncer?.platform)).toBe(process.platform)
    expect(await electronApp.evaluate(({ app, Menu }) => ({ name: app.getName(), menu: Menu.getApplicationMenu() === null }))).toEqual({ name: 'Fy1Sync', menu: process.platform !== 'darwin' })
    const bar = page.locator('.titlebar')
    const controls = bar.locator('.titlebar-controls')
    if (process.platform === 'darwin') {
      await expect(bar).toHaveAttribute('data-platform', 'mac')
      await expect(controls).toHaveCount(0)
      expect(await bar.evaluate(node => Number.parseInt(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(78)
      const roles = await electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.flatMap(item => item.submenu?.items.map(child => child.role) ?? []))
      expect(roles).toEqual(expect.arrayContaining(['quit', 'copy', 'paste', 'undo', 'close']))
    } else {
      expect(await controls.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
    // The system no longer draws caption buttons over the page.
    expect(await page.evaluate(() => (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay?.visible ?? false)).toBe(false)
    const isMaximized = () => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())
    const tint = (name: string) => bar.getByRole('button', { name, exact: true }).evaluate(node => getComputedStyle(node).backgroundColor)

    const maximize = bar.getByRole('button', { name: '最大化', exact: true })
    const idle = await tint('最大化')
    await maximize.hover()
    await expect.poll(() => tint('最大化')).not.toBe(idle)
    await maximize.click()
    await expect.poll(isMaximized).toBe(true)
    // The glyph follows the window, reported by main.
    await bar.getByRole('button', { name: '向下还原', exact: true }).click()
    await expect.poll(isMaximized).toBe(false)
    await expect(maximize).toBeVisible()

    await bar.getByRole('button', { name: '关闭', exact: true }).hover()
    await expect.poll(() => tint('关闭')).toBe('rgb(196, 43, 28)')

    await bar.getByRole('button', { name: '最小化', exact: true }).click()
    }
    if (process.platform === 'darwin') await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true)
    await electronApp.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.restore(); win.focus() })
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
    // HTML fullscreen's top layer covers the outside header even when Chromium
    // still reports the overlay geometry. Verify the actual visible hit target.
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.contains(document.elementFromPoint(12, 12)) ?? false)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('fullscreen-titlebar.png') })
    await page.keyboard.press('f')
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
    await expect(page.locator('.titlebar-name')).toBeVisible()
  })

  test('自绘标题栏的关闭按钮走正常关闭流程', async ({ page, electronApp }) => {
    test.skip(process.platform === 'darwin', 'macOS 使用原生窗口按钮')
    await openPlayer(page)
    const closed = electronApp.evaluate(({ BrowserWindow }) => new Promise<boolean>((resolve) => {
      BrowserWindow.getAllWindows()[0]!.once('close', (event) => { event.preventDefault(); resolve(true) })
    }))
    await page.locator('.titlebar').getByRole('button', { name: '关闭', exact: true }).click()
    expect(await closed).toBe(true)
  })

  test('macOS 关闭最后窗口后通过 Dock 重开, IPC 与本地协议恢复', async ({ page, electronApp }) => {
    test.skip(process.platform !== 'darwin', '需要 macOS 原生应用生命周期')
    await openPlayer(page)
    const nextWindow = electronApp.waitForEvent('window')
    await electronApp.evaluate(({ app, BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.close()
      app.emit('activate')
      app.emit('activate')
    })
    const reopened = await nextWindow
    await reopened.waitForURL(APP_ORIGIN + '/**')
    await expect(reopened.locator('.titlebar-name')).toHaveText('Fy1Sync')
    expect(page.isClosed()).toBe(true)
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await invoke(reopened, 'health', undefined)).toMatchObject({ ok: true, value: { ok: true } })
  })

  test('冷启动渲染播放页和添加直播间且没有 pageerror', async ({ page }) => {
    failOnPageError(page)
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await page.goto(APP_ORIGIN + '/')

    await expect(page).toHaveURL(APP_ORIGIN + '/')
    await expect(page).toHaveTitle('Fy1Sync')
    await expect(page.locator('.studio')).toBeVisible()
    // Nothing is loaded yet, so the dialog is the cold-start entry point.
    await expect(sourceDialog(page)).toBeVisible()
    await expect(page.locator('.theater-main')).toHaveAttribute('data-role', 'official')

    // Both elements exist before any source is chosen: they are owned by MediaEngine, not
    // created per load. That is what lets a swap keep the buffer.
    await expect(page.locator('video.media-element')).toHaveCount(2)
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)
    await closeSourceDialog(page)
    await expect(page.getByRole('button', { name: '添加直播间', exact: true })).toBeVisible()
    expect(pageErrors).toEqual([])
    expect(consoleErrors, `控制台不应有错误：${consoleErrors.join(' | ')}`).toEqual([])
  })

  test('进入播放器后只有「添加直播间」按钮会回到添加直播间, 空片源打开自己的面板', async ({ page }) => {
    await openPlayer(page)
    await revealOverlay(page)
    const commentary = page.locator('.chip[data-role="commentary"]')
    await expect(commentary).toHaveAttribute('data-status', 'empty')
    await page.waitForTimeout(150)
    await commentary.click()
    const panel = page.getByRole('dialog', { name: '解说片源', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('textbox', { name: '解说链接' })).toBeVisible()
    await expect(sourceDialog(page)).toBeHidden()
    await page.keyboard.press('Escape')
    // Leaving for the editor and coming back is not a fresh start either.
    await page.evaluate(() => { history.pushState(null, '', '/admin'); dispatchEvent(new PopStateEvent('popstate')) })
    await page.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')) })
    await expect(page.locator('.studio')).toBeVisible()
    await page.waitForTimeout(300)
    await expect(sourceDialog(page)).toBeHidden()
    await page.getByRole('button', { name: '添加直播间', exact: true }).click()
    await expect(sourceDialog(page)).toBeVisible()
  })

  test('弹幕列表的收起和展开状态在重新加载后保留', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await connectDanmaku(page)
    await expect(page.locator('.drawer')).toBeVisible()
    await page.getByRole('button', { name: '收起弹幕' }).click()
    await expect(page.locator('.drawer')).toBeHidden()
    await expect(page.locator('.studio')).toHaveAttribute('data-chat', 'closed')

    // Settings are persisted, so a reload must not bring it back.
    await page.reload()
    await expect(sourceDialog(page)).toBeVisible()
    await closeSourceDialog(page)
    await loadBothFixtures(page)
    await connectDanmaku(page)
    await expect(page.locator('.drawer')).toBeHidden()
    await revealOverlay(page)
    await page.getByRole('button', { name: '展开弹幕' }).click()
    await expect(page.locator('.drawer')).toBeVisible()
    await page.reload()
    await expect(sourceDialog(page)).toBeVisible()
    await closeSourceDialog(page)
    await loadBothFixtures(page)
    await connectDanmaku(page)
    await expect(page.locator('.drawer')).toBeVisible()
  })

  test('纯房间号的平台选择包含虎牙和抖音', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/')
    const dialog = sourceDialog(page)
    await expect(dialog.getByRole('textbox', { name: '直播间链接' })).toBeDisabled()
    await dialog.getByRole('radiogroup', { name: '添加到' }).getByRole('radio', { name: /^解说/ }).click()
    await dialog.getByRole('textbox', { name: '直播间链接' }).fill('660000')
    const platforms = dialog.getByRole('radiogroup', { name: '选择房间号所属平台' })
    await expect(platforms.getByRole('radio', { name: '虎牙', exact: true })).toBeVisible()
    await expect(platforms.getByRole('radio', { name: '斗鱼', exact: true })).toBeVisible()
    await expect(platforms.getByRole('radio', { name: '哔哩哔哩', exact: true })).toBeVisible()
    await expect(platforms.getByRole('radio', { name: '抖音', exact: true })).toBeVisible()
    await closeSourceDialog(page)
  })

  test('真实全屏保留可操作的片源对话框', async ({ page }, testInfo) => {
    test.skip(!visibleE2eWindows, '真实 HTML 全屏需要可见原生窗口; 设置 STREAM_SYNC_E2E_VISIBLE=1')
    await openPlayer(page)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('studio') ?? false)).toBe(true)
    await openSourceDialog(page)
    await expect(sourceDialog(page)).toBeVisible()
    expect(await sourceDialog(page).evaluate(node => document.fullscreenElement?.contains(node))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('fullscreen-source-dialog.png') })
    await closeSourceDialog(page)
    await page.getByRole('button', { name: '退出全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
    await expect(page.locator('.studio')).toBeVisible()
  })

  test('未加载片源时同步状态显示为零', async ({ page }) => {
    await openPlayer(page)
    expect(await offsetReadout(page)).toEqual({ requested: 0, applied: 0 })
    await expect(page.getByRole('button', { name: '回退画面', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '快进画面', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '自动对齐', exact: true })).toBeDisabled()
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

  test('虎牙平台通过 IPC 参数校验且无效房间不会发起取流', async ({ page }) => {
    const response = await invoke(page, 'resolve', { input: 'not/a/huya-room', platform: 'huya', role: 'commentary' })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.message)
    expect(response.value).toMatchObject({ ok: false, failure: { code: 'unsupported-url' } })
  })

  test('抖音平台通过 IPC 参数校验且拒绝伪造直播域名', async ({ page }) => {
    const response = await invoke(page, 'resolve', { input: 'https://live.douyin.com.evil.invalid/100', platform: 'douyin', role: 'commentary' })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.message)
    expect(response.value).toMatchObject({ ok: false, failure: { code: 'unsupported-url' } })
  })

  test('本机写入仍需通过主进程预设校验', async ({ page }) => {
    const verified = await invoke(page, 'verifyAdmin', { token: '' })
    expect(verified).toEqual({ ok: true, value: { ok: true } })
    const rejected = await invoke(page, 'savePreset', {
      id: 'smoke-should-fail',
      profile: { kind: 'hud-style-pack', schemaVersion: 1, id: 'smoke-should-fail' } as HudStylePack,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('Invalid profile was unexpectedly accepted')
    expect(rejected.code).toBe('invalid-profile')
    expect(rejected.detail).toHaveProperty('issues')
    const stored = await invoke(page, 'getPreset', { id: 'smoke-should-fail' })
    expect(stored.ok).toBe(false)
  })

  test('媒体路径拒绝凭据注入和未登记标识', async ({ page }) => {
    const response = await invoke(page, 'resolve', {
      input: 'http://synthetic-user:synthetic-password@127.0.0.1:8080/secret', platform: 'direct',
    })
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('Credential-bearing media URL was unexpectedly accepted')
    expect(response.code).toBe('invalid-url')
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
