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

import { expect, test } from './electron'
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

    // ▶ rewinds the commentary side (negative offset), so official − commentary grows.
    await sidebar.getByRole('button', { name: '解说后退 0.5s' }).click()
    await sidebar.getByRole('button', { name: '解说后退 0.5s' }).click()

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

  test('连接房间后弹幕出现在画面上并向左移动', async ({ page, electronApp }) => {
    // The relay's upstream is Douyu's socket, which a test must not depend on. Stubbing the
    // main-process events keep everything downstream real: preload IPC, the timeline's
    // scheduling against the commentary playhead, lane assignment and the rAF loop.
    await stubDanmakuStream(electronApp, ['E2E 弹幕 0', 'E2E 弹幕 1', 'E2E 弹幕 2', 'E2E 弹幕 3'])

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

  test('关闭弹幕后立即清空画面', async ({ page, electronApp }) => {
    await stubDanmakuStream(electronApp, ['要被清掉的弹幕', '第二条', '第三条'])
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

  test('全屏时摄像头取景对话框仍可打开和关闭', async ({ page }, testInfo) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await revealOverlay(page)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    await page.locator('.overlay-bar').getByRole('button', { name: /^摄像头/ }).click()
    await page.getByRole('option', { name: '框选摄像头…' }).click()
    const dialog = page.getByRole('dialog', { name: '摄像头小窗取景' })
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(node => document.fullscreenElement?.contains(node))).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('fullscreen-camera-dialog.png') })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('button', { name: '退出全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  })

  test('框选摄像头后自动收紧、显示小窗并按房间记住', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)
    await revealOverlay(page)

    const bar = page.locator('.overlay-bar')
    // Anchored: an accessible name is label + value, so /画质/ alone would match 摄像头 too.
    const camera = bar.getByRole('button', { name: /^摄像头/ })
    await expect(camera).toBeEnabled()
    await camera.click()
    await page.getByRole('option', { name: '框选摄像头…' }).click()

    const dialog = page.getByRole('dialog', { name: '摄像头小窗取景' })
    await expect(dialog).toBeVisible()
    // The default rough box (x .02 y .4 w .16 h .2) covers the fixture camera at 64,400
    // 256x144 on 1280x720 only partly; grow it past the camera's right and bottom edges the
    // way a user would, then check the size label says it is now loose all round.
    await dialog.locator('.roi-window').focus()
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowRight')
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowDown')
    const [roughW, roughH] = ((await dialog.locator('.roi-size').textContent()) ?? '').split('×').map(Number)
    expect(roughW).toBeGreaterThan(300)
    expect(roughH).toBeGreaterThan(270)
    await dialog.getByRole('button', { name: '自动收紧' }).click()
    await expect(dialog.getByRole('status')).toContainText('已收紧', { timeout: 15_000 })

    // The tightened box, read back off the window's size label (video pixels).
    const size = await dialog.locator('.roi-size').textContent()
    const [w, h] = (size ?? '').split('×').map(Number)
    expect(Math.abs(w! - 256)).toBeLessThanOrEqual(4)
    expect(Math.abs(h! - 144)).toBeLessThanOrEqual(4)

    await dialog.getByRole('button', { name: '保存并显示' }).click()
    const overlay = page.locator('.camera-overlay')
    await expect(overlay).toBeVisible()
    // The canvas is drawing the commentary picture, not sitting blank.
    await expect.poll(() => overlay.locator('canvas').evaluate((node: HTMLCanvasElement) => {
      const data = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data
      let lit = 0
      for (let i = 0; i < data.length; i += 4) if (data[i]! + data[i + 1]! + data[i + 2]! > 60) lit += 1
      return lit / (data.length / 4)
    })).toBeGreaterThan(0.2)

    // Drag it somewhere else; the position is saved for this room.
    const box = (await overlay.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 40, { steps: 6 })
    await page.mouse.up()
    const moved = (await overlay.boundingBox())!
    expect(moved.x - box.x).toBeGreaterThan(150)

    // Reloading the same commentary brings the camera back where it was.
    await page.reload()
    await expect(page.locator('.player-page')).toBeVisible()
    await loadBothFixtures(page)
    await expect(page.locator('.camera-overlay')).toBeVisible()
    const restored = (await page.locator('.camera-overlay').boundingBox())!
    expect(Math.abs(restored.x - moved.x)).toBeLessThan(4)

    // Hidden from the menu, kept in storage.
    await revealOverlay(page)
    await bar.getByRole('button', { name: /^摄像头/ }).click()
    await page.getByRole('option', { name: '隐藏小窗' }).click()
    await expect(page.locator('.camera-overlay')).toHaveCount(0)
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
