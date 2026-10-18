/**
 * The Profile Editor: token gate, sample → frame → segmentation, and the publish round-trip.
 *
 * The gate tests run without fixtures because they are about the deployed page's access
 * control, not about media. The editor tests need `npm run fixtures`, since a real decoded
 * frame is the only way to exercise grab → segment → template.
 */

import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { ADMIN_TOKEN, failOnPageError, fixturesReady } from './helpers'

const officialPath = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

test.describe('管理令牌', () => {
  test('没有令牌时只显示登录卡片', async ({ page }) => {
    failOnPageError(page)
    await page.goto('/admin')
    await expect(page.locator('.admin-gate')).toBeVisible()
    await expect(page.locator('.admin-columns')).toHaveCount(0)
  })

  test('错误令牌被服务端拒绝并给出提示', async ({ page }) => {
    failOnPageError(page)
    await page.goto('/admin')
    await page.locator('.gate-field input').fill('definitely-not-the-token')
    await page.getByRole('button', { name: '进入' }).click()
    await expect(page.locator('.gate-error')).toBeVisible()
    await expect(page.locator('.admin-columns')).toHaveCount(0)
  })

  test('URL 中的令牌可用一次，随后从地址栏消失', async ({ page }) => {
    failOnPageError(page)
    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await expect(page.locator('.admin-columns')).toBeVisible()

    // The query string is where a token leaks from: history, titles, screenshots.
    await expect.poll(() => new URL(page.url()).searchParams.get('token')).toBeNull()

    // It survives a reload through sessionStorage, so the editor is usable without
    // pasting the token again — and without it ever going back into the URL.
    await page.reload()
    await expect(page.locator('.admin-columns')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('token')).toBeNull()
  })

  test('退出后回到登录卡片', async ({ page }) => {
    failOnPageError(page)
    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await expect(page.locator('.admin-columns')).toBeVisible()
    await page.getByRole('button', { name: '退出' }).click()
    await expect(page.locator('.admin-gate')).toBeVisible()
    // And it stays locked across a reload: clearing must wipe the stored token, not just
    // the component state.
    await page.reload()
    await expect(page.locator('.admin-gate')).toBeVisible()
  })
})

test.describe('取帧与切分', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('载入样片后取帧并切出字符框', async ({ page }) => {
    failOnPageError(page)
    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await expect(page.locator('.admin-columns')).toBeVisible()

    await page.locator('.stage-toolbar input[type=file]').setInputFiles(officialPath)
    const video = page.locator('video.admin-video')
    await expect(video).toBeVisible()
    await expect.poll(async () => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)

    // Point the ROI at the countdown the fixture generator drew, then grab.
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await seekSample(page, 1)
    await page.getByRole('button', { name: '取当前帧' }).click()

    // Both previews come from the same analysis, so a mask means segmentation ran.
    await expect(page.locator('.preview-canvas').first()).toBeVisible()
    // 0:19 at t=1s — four glyphs.
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  })

  test('点字符按钮把选中的框存成模板样本', async ({ page }) => {
    failOnPageError(page)
    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await page.locator('.stage-toolbar input[type=file]').setInputFiles(officialPath)
    await expect.poll(async () =>
      page.locator('video.admin-video').evaluate((node: HTMLVideoElement) => node.videoWidth),
    ).toBeGreaterThan(0)
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await seekSample(page, 1)
    await page.getByRole('button', { name: '取当前帧' }).click()
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThan(0)

    const emptyBefore = await page.locator('.template-cell.is-empty').count()
    await page.locator('.glyph-box').first().click()
    // 0:19 reads 0, :, 1, 9 left to right; the pad auto-advances, so one click per glyph.
    for (const char of ['0', ':', '1', '9']) {
      await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
    }

    await expect(page.locator('.admin-header .hint')).toContainText('4 个样本')
    expect(await page.locator('.template-cell.is-empty').count()).toBeLessThan(emptyBefore)
  })
})

test.describe('发布预设', () => {
  test('发布后可以通过接口读回，并带 etag', async ({ page, request }) => {
    failOnPageError(page)
    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await expect(page.locator('.admin-columns')).toBeVisible()

    const id = `e2e/publish-${Date.now()}`
    await setField(page, '标识', id)
    await setField(page, '名称', 'E2E 发布测试')
    await page.getByRole('button', { name: '发布到服务端' }).click()
    await expect(page.locator('.admin-message.is-info')).toContainText('已发布')

    const fetched = await request.get(`/api/presets/${id}`)
    expect(fetched.status()).toBe(200)
    const body = (await fetched.json()) as { profile: { id: string; name: string }; etag: string }
    expect(body.profile.id).toBe(id)
    expect(body.profile.name).toBe('E2E 发布测试')
    expect(body.etag).toBeTruthy()

    // It also shows up in the library listing the editor reads on load.
    const list = await request.get('/api/presets')
    const listed = (await list.json()) as { presets: { id: string }[] }
    expect(listed.presets.some((preset) => preset.id === id)).toBe(true)
  })

  test('别的会话改动过预设时发布被拒绝', async ({ page, request }) => {
    failOnPageError(page)
    const id = `e2e/conflict-${Date.now()}`

    // Seed the preset so the editor picks up an etag when it loads it. The id is fresh,
    // so this creates (201); the interleaved write below updates the same id (200).
    const seed = await request.put(`/api/presets/${id}`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      data: { ...baseProfile(id), name: '初始版本' },
    })
    expect(seed.status()).toBe(201)

    await page.goto(`/admin?token=${ADMIN_TOKEN}`)
    await page.locator('.library-item').filter({ hasText: id }).first().click()
    await expect(page.locator('.admin-message')).toContainText('已载入预设')

    // A third party writes in between, which moves the etag out from under the editor.
    const interleaved = await request.put(`/api/presets/${id}`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      data: { ...baseProfile(id), name: '别人的版本' },
    })
    expect(interleaved.status()).toBe(200)

    await setField(page, '名称', '我的版本')
    await page.getByRole('button', { name: '发布到服务端' }).click()
    // Last-write-wins would silently discard the other session's edit.
    await expect(page.locator('.admin-message.is-error')).toContainText('已被其他会话改动')

    const after = await request.get(`/api/presets/${id}`)
    const body = (await after.json()) as { profile: { name: string } }
    expect(body.profile.name).toBe('别人的版本')
  })
})

/** A minimal valid profile for seeding through the API. */
function baseProfile(id: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: '种子预设',
    roi: { x: 0.44, y: 0.02, w: 0.12, h: 0.07 },
    clockFormat: 'm:ss',
    detectWindowSeconds: 3,
    sampleFps: 30,
    matchThreshold: 0.82,
    preprocess: { scale: 1, threshold: 128, invert: false },
    templates: {},
    updatedAt: 0,
  }
}

/**
 * Fill a labelled field in the library column.
 *
 * Matched on the label's own text node rather than with `hasText` on the row: `hasText` is
 * case-insensitive and matches substrings, so a one-character label would also match the
 * pixel hint rendered beside it.
 */
async function setField(page: Page, label: string, value: string): Promise<void> {
  const field = page
    .locator('.admin-library-column .field')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first()
  await field.locator('input, textarea').first().fill(value)
}

/** The four ROI inputs render in a fixed order: x, y, w, h. */
async function setRoi(page: Page, roi: { x: number; y: number; w: number; h: number }): Promise<void> {
  const inputs = page.locator('.roi-field input')
  for (const [index, value] of [roi.x, roi.y, roi.w, roi.h].entries()) {
    await inputs.nth(index).fill(String(value))
  }
}

/** Seek the sample element directly; the editor grabs on `seeked`. */
async function seekSample(page: Page, seconds: number): Promise<void> {
  await page.locator('video.admin-video').evaluate((node: HTMLVideoElement, to: number) => {
    node.currentTime = to
  }, seconds)
  await page.waitForTimeout(500)
}
