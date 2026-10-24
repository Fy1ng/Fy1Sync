/** The local editor: trusted app access, decoded-frame teaching and preset IPC. */

import { fileURLToPath } from 'node:url'
import { type Page } from '@playwright/test'
import type { RecognitionProfile } from '../src/core/profileSchema'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import { packBitmap } from '../src/core/bitmapCodec'
import { APP_ORIGIN, expect, test } from './electron'
import { failOnPageError, fixturesReady, invoke } from './helpers'

const officialPath = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))
const framePath = fileURLToPath(new URL('../public/test-sources/frame-0-20.png', import.meta.url))

test.describe('本机编辑器访问', () => {
  test('草稿修改必须发布后才能应用, 返回播放器读取已发布版本', async ({ page }) => {
    failOnPageError(page)
    const id = 'e2e/draft-publication'
    const profile = baseProfile(id)
    profile.templates = Object.fromEntries(CLOCK_CHARS.map(char => [char, [{
      id: char, data: packBitmap(new Uint8Array(TEMPLATE_PIXELS).fill(255)), createdAt: 1,
    }]]))
    const seeded = await invoke(page, 'savePreset', { id, profile })
    expect(seeded.ok).toBe(true)
    await page.goto(APP_ORIGIN + '/admin')
    await page.getByRole('button', { name: /种子预设/ }).click()
    await setField(page, '名称', '草稿中的修改')
    await page.getByRole('button', { name: '存为草稿', exact: true }).click()
    await expect(page.locator('.admin-message')).toContainText('已保存到本机草稿')
    await page.getByRole('button', { name: '应用到播放器' }).click()
    await expect(page.locator('.admin-message')).toContainText('请先')
    const before = await invoke(page, 'getPreset', { id })
    expect(before.ok && before.value.profile.name).toBe('种子预设')
    await page.getByRole('button', { name: '发布到本机', exact: true }).click()
    await expect(page.locator('.admin-message')).toContainText('已发布为本机预设')
    await page.getByRole('button', { name: '应用到播放器' }).click()
    await expect(page.locator('.admin-message')).toContainText('已设为播放器的识别场景')
    await page.getByRole('link', { name: '返回播放器' }).click()
    await page.getByRole('dialog', { name: '片源设置' }).getByRole('button', { name: '完成' }).click()
    await expect(page.locator('.sidebar').getByRole('button', { name: /^识别场景/ })).toContainText('草稿中的修改')
  })

  test('本机窗口直接显示编辑器而无需令牌', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()
    await expect(page.locator('.admin-gate')).toHaveCount(0)
  })

  test('本机可信窗口仍拒绝无效预设并给出字段问题', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    const rejected = await invoke(page, 'savePreset', {
      id: 'e2e/invalid',
      profile: { schemaVersion: 2, id: 'e2e/invalid' } as RecognitionProfile,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('Invalid profile was unexpectedly written')
    expect(rejected.code).toBe('invalid-profile')
    expect(rejected.detail).toHaveProperty('issues')
    expect((await invoke(page, 'getPreset', { id: 'e2e/invalid' })).ok).toBe(false)
  })

  test('刷新后编辑器仍可用且地址中没有令牌', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('token')).toBe(false)
    await page.reload()
    await expect(page.locator('.admin-columns')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('token')).toBe(false)
  })

  test('返回播放器后仍可在同一本机窗口进入编辑器', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()
    await page.getByRole('link', { name: '返回播放器' }).click()
    await expect(page.locator('.player-page')).toBeVisible()
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()
  })
})

test.describe('取帧与切分', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('载入样片后取帧并切出字符框', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()

    await page.locator('.stage-toolbar input[accept="video/*"]').setInputFiles(officialPath)
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
    await page.goto(APP_ORIGIN + '/admin')
    await page.locator('.stage-toolbar input[accept="video/*"]').setInputFiles(officialPath)
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
  test('发布后可以通过接口读回，并带 etag', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()

    const id = `e2e/publish-${Date.now()}`
    await setField(page, '标识', id)
    await setField(page, '名称', 'E2E 发布测试')
    await page.getByRole('button', { name: '发布到本机' }).click()
    await expect(page.locator('.admin-message.is-info')).toContainText('已发布')

    const fetched = await invoke(page, 'getPreset', { id })
    expect(fetched.ok).toBe(true)
    if (!fetched.ok) throw new Error(fetched.message)
    const body = fetched.value
    expect(body.profile.id).toBe(id)
    expect(body.profile.name).toBe('E2E 发布测试')
    expect(body.etag).toBeTruthy()

    // It also shows up in the library listing the editor reads on load.
    const list = await invoke(page, 'listPresets', undefined)
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error(list.message)
    expect(list.value.presets.some((preset) => preset.id === id)).toBe(true)
  })

  test('别的会话改动过预设时发布被拒绝', async ({ page }) => {
    failOnPageError(page)
    const id = `e2e/conflict-${Date.now()}`

    // Seed through the actual preload so the editor loads the stored ETag.
    const seed = await invoke(page, 'savePreset', { id, profile: { ...baseProfile(id), name: '初始版本' } })
    expect(seed.ok).toBe(true)

    await page.goto(APP_ORIGIN + '/admin')
    await page.locator('.library-item').filter({ hasText: id }).first().click()
    await expect(page.locator('.admin-message')).toContainText('已载入预设')

    // A third party writes in between, which moves the etag out from under the editor.
    const interleaved = await invoke(page, 'savePreset', { id, profile: { ...baseProfile(id), name: '别人的版本' } })
    expect(interleaved.ok).toBe(true)

    await setField(page, '名称', '我的版本')
    await page.getByRole('button', { name: '发布到本机' }).click()
    // Last-write-wins would silently discard the other session's edit.
    await expect(page.locator('.admin-message.is-error')).toContainText('已在别处被修改')

    const after = await invoke(page, 'getPreset', { id })
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error(after.message)
    const body = after.value
    expect(body.profile.name).toBe('别人的版本')

    // Overwriting is a deliberate, named choice and then wins against that version.
    await page.getByRole('button', { name: '用我的版本覆盖' }).click()
    await expect(page.locator('.admin-message.is-info')).toContainText('已发布为本机预设')
    const overwritten = await invoke(page, 'getPreset', { id })
    expect(overwritten.ok && overwritten.value.profile.name).toBe('我的版本')
  })

  test('截图样片可选择也可粘贴，并切出字符框', async ({ page }) => {
    test.skip(!fixturesReady(), '需要先运行 npm run fixtures')
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.admin-columns')).toBeVisible()

    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await page.locator('.stage-toolbar input[accept^="image/"]').setInputFiles(framePath)
    await expect(page.locator('img.admin-video')).toBeVisible()
    await expect(page.locator('.admin-message')).toContainText('1280×720')
    // The still is the frame: no grabbing, and 0:20 segments into its glyphs.
    await expect(page.getByRole('button', { name: '取当前帧' })).toBeDisabled()
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3)

    // Paste the same picture through a real ClipboardEvent carrying a File.
    const bytes = [...await (await import('node:fs/promises')).readFile(framePath)]
    await page.evaluate((data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'clip.png', { type: 'image/png' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
    }, bytes)
    await expect(page.locator('.admin-message')).toContainText('粘贴的截图')

    // An unsupported image is refused with a reason rather than silently ignored.
    await page.locator('.stage-toolbar input[accept^="image/"]').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
    await expect(page.locator('.admin-message.is-error')).toContainText('只支持 PNG、JPEG 或 WebP')
  })
})

/** A minimal valid profile for seeding through the API. */
function baseProfile(id: string): RecognitionProfile {
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
