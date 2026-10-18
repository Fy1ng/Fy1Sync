/**
 * V0.1–V0.3 in the browser: two real sources, manual sync, role swap, danmaku overlay.
 *
 * Assertions read `currentTime` off the elements rather than the sidebar's text. The
 * sidebar rounds to two decimals and is a view of the session's bookkeeping; reading the
 * elements checks the thing that actually has to be true — that the two playheads moved
 * relative to each other by the amount that was asked for.
 *
 * Requires `npm run fixtures`.
 */

import { expect, test } from '@playwright/test'
import {
  FIXTURES,
  fixturesReady,
  hlsFixtureReady,
  loadBothFixtures,
  loadSource,
  mediaTimes,
  offsetReadout,
  openPlayer,
  revealOverlay,
  seekBoth,
  setPlaying,
  stubDanmakuStream,
  waitForBothReady,
} from './helpers'

test.describe('双路播放与手动同步', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('加载两路片源后主画面与预览各持一个元素', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)

    // One element in the stage, one in the preview slot — and they are the same two
    // elements that existed before loading.
    await expect(page.locator('.stage-main video.media-element')).toHaveCount(1)
    await expect(page.locator('.preview-mount video.media-element')).toHaveCount(1)
    await expect(page.locator('.stage-main')).toHaveAttribute('data-role', 'official')

    const times = await mediaTimes(page)
    expect(Number.isFinite(times.official)).toBe(true)
    expect(Number.isFinite(times.commentary)).toBe(true)
  })

  test('切换主画面移动同一个元素而不重建', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)

    // Mark the element, swap, and look for the mark: a remount would lose it, and with it
    // the buffer and the playhead that sync depends on.
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('.stage-main video')
      if (video) video.dataset.e2eMark = 'original-main'
    })

    await page.locator('.preview-slot').click()
    await expect(page.locator('.stage-main')).toHaveAttribute('data-role', 'commentary')
    await expect(page.locator('.preview-mount video')).toHaveAttribute(
      'data-e2e-mark',
      'original-main',
    )
    await expect(page.locator('.preview-mount video')).toHaveAttribute('data-role', 'official')
  })

  test('手动偏移把解说回退到指定位置', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)

    // Away from 0 so both sides have rewind head-room in either direction.
    await seekBoth(page, 12, 12)
    await setPlaying(page, false)

    const before = await mediaTimes(page)
    const sidebar = page.locator('.sidebar')

    // A negative offset rewinds the commentary side, so official − commentary grows.
    await sidebar.getByRole('button', { name: '−0.5s' }).click()
    await sidebar.getByRole('button', { name: '−0.5s' }).click()

    await expect
      .poll(async () => (await offsetReadout(page)).requested, { timeout: 15_000 })
      .toBeCloseTo(-1, 2)
    await expect
      .poll(async () => (await mediaTimes(page)).lag, { timeout: 15_000 })
      .toBeGreaterThan(before.lag + 0.6)

    // 目标 and 实际 agree here: a VOD fixture at t=12 has the head-room to absorb it.
    const readout = await offsetReadout(page)
    expect(readout.applied).toBeCloseTo(-1, 1)
    await expect(sidebar.locator('.status-warning')).toHaveCount(0)

    await sidebar.getByRole('button', { name: '归零' }).click()
    await expect
      .poll(async () => (await offsetReadout(page)).requested, { timeout: 15_000 })
      .toBeCloseTo(0, 2)
    await expect
      .poll(async () => Math.abs((await mediaTimes(page)).lag - before.lag), { timeout: 15_000 })
      .toBeLessThan(0.35)
  })

  test('播放按钮同时驱动两路', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 4, 4)

    await setPlaying(page, true)
    const start = await mediaTimes(page)
    await page.waitForTimeout(1200)
    const later = await mediaTimes(page)

    expect(later.official).toBeGreaterThan(start.official + 0.4)
    expect(later.commentary).toBeGreaterThan(start.commentary + 0.4)

    await setPlaying(page, false)
    const paused = await mediaTimes(page)
    await page.waitForTimeout(600)
    const stillPaused = await mediaTimes(page)
    expect(Math.abs(stillPaused.official - paused.official)).toBeLessThan(0.1)
    expect(Math.abs(stillPaused.commentary - paused.commentary)).toBeLessThan(0.1)
  })

  test('解说走 HLS 时同样加载成功', async ({ page }) => {
    test.skip(!hlsFixtureReady(), '缺少 HLS 测试源')
    await openPlayer(page)
    await loadSource(page, 'official', FIXTURES.official)
    await loadSource(page, 'commentary', FIXTURES.commentaryHls)
    await page.getByRole('button', { name: '完成' }).click()
    await waitForBothReady(page)

    const times = await mediaTimes(page)
    expect(Number.isFinite(times.commentary)).toBe(true)
  })
})

test.describe('弹幕叠加层', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('连接房间后弹幕出现在画面上并向左移动', async ({ page }) => {
    // The relay's upstream is Douyu's socket, which a test must not depend on. Stubbing the
    // SSE response keeps everything downstream real: EventSource parsing, the timeline's
    // scheduling against the commentary playhead, lane assignment and the rAF loop.
    await stubDanmakuStream(page, ['E2E 弹幕 0', 'E2E 弹幕 1', 'E2E 弹幕 2', 'E2E 弹幕 3'])

    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)

    const dialog = page.getByRole('dialog', { name: '片源设置' })
    await page.locator('.stage-top').getByRole('button', { name: '片源设置' }).click()
    const room = dialog.locator('.danmaku-room')
    await room.getByRole('textbox').fill('288016')
    await room.getByRole('button', { name: '连接' }).click()
    await dialog.getByRole('button', { name: '完成' }).click()

    const item = page.locator('.danmaku-item').first()
    await expect(item).toBeVisible({ timeout: 20_000 })

    // Either it moved left, or it already ran off the edge and was recycled.
    const first = await item.evaluate((node) => node.getBoundingClientRect().left)
    await page.waitForTimeout(700)
    const second = await item
      .evaluate((node) => node.getBoundingClientRect().left)
      .catch(() => Number.NEGATIVE_INFINITY)
    expect(second).toBeLessThan(first)
  })

  test('关闭弹幕后立即清空画面', async ({ page }) => {
    await stubDanmakuStream(page, ['要被清掉的弹幕', '第二条', '第三条'])
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)

    const dialog = page.getByRole('dialog', { name: '片源设置' })
    await page.locator('.stage-top').getByRole('button', { name: '片源设置' }).click()
    const room = dialog.locator('.danmaku-room')
    await room.getByRole('textbox').fill('288016')
    await room.getByRole('button', { name: '连接' }).click()
    await dialog.getByRole('button', { name: '完成' }).click()
    await expect(page.locator('.danmaku-item').first()).toBeVisible({ timeout: 20_000 })

    // The wait above outlasts the overlay's idle timeout, so bring the bar back first.
    await revealOverlay(page)
    await page.locator('.overlay-bar').getByRole('button', { name: /^弹幕[开关]$/ }).click()
    await expect(page.locator('.danmaku-item')).toHaveCount(0)
  })
})

test.describe('底部浮层画质入口', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('两个画质入口并存，摄像头画质保持预留', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await revealOverlay(page)

    const bar = page.locator('.overlay-bar')
    // The anchor matters: a trigger's accessible name is label + current value, so an
    // unanchored /画质/ also matches 摄像头画质 and the two entries stop being distinguishable.
    const camera = bar.getByRole('button', { name: /^摄像头画质/ })
    await expect(bar.getByRole('button', { name: /^画质/ })).toBeVisible()
    await expect(camera).toBeVisible()

    // Reserved for V0.6, so it must not imply the webcam already works: disabled, and its
    // menu stays shut when clicked. `force` because a disabled button swallows a real click —
    // the point is that even a delivered press opens nothing.
    await expect(camera).toBeDisabled()
    await camera.click({ force: true })
    await expect(page.getByRole('listbox')).toHaveCount(0)

    // Progressive MP4 has no ladder, so the main entry has nothing to offer either, and it
    // says why rather than opening onto an empty menu.
    const quality = bar.getByRole('button', { name: /^画质/ })
    await expect(quality).toBeDisabled()
    await expect(quality).toHaveAttribute('title', '当前片源没有可选画质')
  })

  test('HLS 主画面的画质菜单在播放器内向上展开', async ({ page }) => {
    test.skip(!hlsFixtureReady(), '缺少 HLS 测试源')
    await openPlayer(page)
    await loadBothFixtures(page, FIXTURES.commentaryHls)

    // The ladder belongs to the HLS source, so make it the main picture — 画质 always drives
    // whatever is on stage.
    await page.locator('.preview-slot').click()
    await expect(page.locator('.stage-main')).toHaveAttribute('data-role', 'commentary')

    await revealOverlay(page)
    const quality = page.locator('.overlay-bar').getByRole('button', { name: /^画质/ })
    // Levels arrive on MANIFEST_PARSED, which is not ordered against the readiness wait.
    await expect(quality).toBeEnabled({ timeout: 20_000 })
    await quality.click()

    const menu = page.getByRole('listbox', { name: '画质' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option', { name: /自动/ })).toBeVisible()

    // Why this control exists instead of a native `<select>`: docs/ui-layout.md wants menus
    // that open upward inside the player, because an OS popup is painted above the
    // fullscreen surface and cannot be positioned. Only a real browser can confirm it.
    const trigger = await quality.boundingBox()
    const box = await menu.boundingBox()
    const stage = await page.locator('.stage').boundingBox()
    expect(trigger).not.toBeNull()
    expect(box).not.toBeNull()
    expect(stage).not.toBeNull()
    if (!trigger || !box || !stage) return

    expect(box.y + box.height).toBeLessThanOrEqual(trigger.y)
    expect(box.y).toBeGreaterThanOrEqual(stage.y)
    expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)

    // Escape dismisses it, so the menu never traps a keyboard user inside the overlay.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})
