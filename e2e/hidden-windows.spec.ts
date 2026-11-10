import { APP_ORIGIN, expect, test, visibleE2eWindows } from './electron'
import { FIXTURES, fixturesReady, invoke } from './helpers'

test.describe('隐藏 E2E 窗口', () => {
  test.skip(visibleE2eWindows, '本组验证默认隐藏模式; STREAM_SYNC_E2E_VISIBLE=1 运行可见窗口专属用例')

  test('主窗口隐藏且不聚焦, 页面和 health 正常, activate 不显示窗口', async ({ page, electronApp }) => {
    await expect(page.locator('.studio')).toBeVisible()
    await expect(page.locator('.titlebar-name')).toHaveText('Fy1Sync')
    expect(await page.evaluate(() => window.streamSyncer?.platform)).toBe(process.platform)
    expect(await invoke(page, 'health', undefined)).toMatchObject({ ok: true, value: { ok: true } })
    const snapshot = () => electronApp.evaluate(({ BrowserWindow }) => ({
      mode: process.env.STREAM_SYNC_E2E, visibleMode: process.env.STREAM_SYNC_E2E_VISIBLE,
      windows: BrowserWindow.getAllWindows().map(window => ({
        visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
      })),
    }))
    expect(await snapshot()).toEqual({ mode: '1', visibleMode: '0', windows: [{ visible: false, focused: false, focusable: false }] })
    await electronApp.evaluate(({ app }) => { app.emit('activate'); app.emit('activate') })
    expect(await snapshot()).toEqual({ mode: '1', visibleMode: '0', windows: [{ visible: false, focused: false, focusable: false }] })
    await page.reload()
    await expect(page.locator('.studio')).toBeVisible()
    expect(await invoke(page, 'health', undefined)).toMatchObject({ ok: true, value: { ok: true } })
    expect((await snapshot()).windows).toEqual([{ visible: false, focused: false, focusable: false }])
  })

  test('增强画中画页面真实就绪后主窗口和 PiP 都保持隐藏', async ({ page, electronApp }) => {
    test.skip(!fixturesReady(), '需要 npm run fixtures 生成可丢弃的本地媒体样例')
    expect(await invoke(page, 'resolve', { input: FIXTURES.official, role: 'official' })).toMatchObject({ ok: true, value: { ok: true } })
    const nextWindow = electronApp.waitForEvent('window')
    expect(await invoke(page, 'openEnhancedPip', { id: 'official', options: { lowPower: true } }))
      .toMatchObject({ ok: true, value: { streamId: 'official' } })
    const pip = await nextWindow
    await pip.waitForURL(APP_ORIGIN + '/pip')
    await expect(pip.locator('.pip-page')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 })
    await expect.poll(() => invoke(page, 'getEnhancedPip', undefined)).toMatchObject({ ok: true, value: { phase: 'ready', audioOwner: 'pip' } })
    const windows = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
      path: new URL(window.webContents.getURL()).pathname,
      visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(),
    })))
    expect(windows).toHaveLength(2)
    expect(windows).toEqual(expect.arrayContaining([
      { path: '/', visible: false, focused: false, focusable: false },
      { path: '/pip', visible: false, focused: false, focusable: false },
    ]))
    expect(await invoke(page, 'closeEnhancedPip', undefined)).toMatchObject({ ok: true, value: { phase: 'closed' } })
    await expect.poll(() => pip.isClosed()).toBe(true)
    expect(await invoke(page, 'health', undefined)).toMatchObject({ ok: true, value: { ok: true } })
  })
})
