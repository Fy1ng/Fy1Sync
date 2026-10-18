/**
 * The deployability check: does the built page actually come up and serve its own API?
 *
 * These run without fixtures on purpose. A checkout with no ffmpeg output should still be
 * able to prove the server boots, the bundle loads, the shell renders and the admin
 * surface is closed — which is the difference between "the code compiles" and "the page
 * is deployable".
 */

import { expect, test } from '@playwright/test'
import { ADMIN_TOKEN, failOnPageError, openPlayer, sourceDialog } from './helpers'

test.describe('应用外壳', () => {
  test('冷启动渲染播放页并打开片源对话框', async ({ page }) => {
    failOnPageError(page)
    const consoleErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await page.goto('/')

    await expect(page.locator('.player-page')).toBeVisible()
    // Nothing is loaded yet, so the dialog is the cold-start entry point.
    await expect(sourceDialog(page)).toBeVisible()
    await expect(page.locator('.stage-main')).toHaveAttribute('data-role', 'official')

    // Both elements exist before any source is chosen: they are owned by MediaEngine, not
    // created per load. That is what lets a swap keep the buffer.
    await expect(page.locator('video.media-element')).toHaveCount(2)

    expect(consoleErrors, `控制台不应有错误：${consoleErrors.join(' | ')}`).toEqual([])
  })

  test('侧栏可收起并保留在设置里', async ({ page }) => {
    await openPlayer(page)

    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar').getByRole('button', { name: '收起' }).click()
    await expect(page.locator('.sidebar')).toBeHidden()
    await expect(page.locator('.player-page')).toHaveClass(/no-sidebar/)

    // Settings are persisted, so a reload must not bring it back.
    await page.reload()
    await expect(page.locator('.player-page')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeHidden()
  })

  test('未加载片源时同步状态显示为零', async ({ page }) => {
    await openPlayer(page)
    const sidebar = page.locator('.sidebar')
    await expect(sidebar.locator('.status-pill')).toBeVisible()
    await expect(sidebar.locator('.sync-headroom')).toContainText('未加载')
  })
})

test.describe('服务端接口', () => {
  test('/api/health 报告运行状态', async ({ request }) => {
    const response = await request.get('/api/health')
    expect(response.ok()).toBe(true)
    const body = (await response.json()) as { ok: boolean; version?: string }
    expect(body.ok).toBe(true)
  })

  test('/api/resolve 对无法解析的输入返回结构化失败而非 5xx', async ({ request }) => {
    const response = await request.post('/api/resolve', {
      data: { input: 'not-a-stream-at-all', platform: 'auto' },
    })
    // A failure to resolve is an answer, not a server error: the UI needs the reason and
    // the hint so it can ask for a direct media URL instead of showing a stack trace.
    expect(response.status()).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      failure?: { reason: string; message: string }
    }
    expect(body.ok).toBe(false)
    expect(body.failure?.message).toBeTruthy()
  })

  test('预设写入需要管理令牌', async ({ request }) => {
    const unauthorized = await request.put('/api/presets/smoke-should-fail', {
      data: { schemaVersion: 2, id: 'smoke-should-fail' },
    })
    expect(unauthorized.status()).toBe(403)

    const verified = await request.post('/api/admin/verify', { data: { token: ADMIN_TOKEN } })
    expect(verified.ok()).toBe(true)
    expect(((await verified.json()) as { ok: boolean }).ok).toBe(true)

    // A wrong token gets a bare 403 with no hint about the expected length or content.
    const wrong = await request.post('/api/admin/verify', { data: { token: 'wrong-token' } })
    expect(wrong.status()).toBe(403)
    const body = (await wrong.json()) as { error?: { code: string; message: string } }
    expect(body.error?.code).toBe('bad-token')
    expect(body.error?.message).not.toContain(ADMIN_TOKEN)
  })

  test('媒体代理拒绝内网目标', async ({ request }) => {
    // SSRF guard: the proxy exists to add a Referer for a public CDN, not to let the page
    // reach anything the host itself can reach.
    const response = await request.get('/api/proxy?url=http://127.0.0.1:9/secret')
    expect(response.status()).toBeGreaterThanOrEqual(400)
    expect(response.status()).toBeLessThan(500)
  })

  test('未知接口返回 404 而不是落到静态资源', async ({ request }) => {
    const response = await request.get('/api/definitely-not-a-route')
    expect(response.status()).toBe(404)
  })
})
