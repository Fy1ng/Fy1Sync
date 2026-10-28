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
  closeSourceDialog,
  connectDanmaku,
  fixturesReady,
  hlsFixtureReady,
  loadBothFixtures,
  loadSource,
  mediaTimes,
  offsetReadout,
  openCameraFraming,
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
    await expect(page.locator('.theater-main video.media-element')).toHaveCount(1)
    await expect(page.locator('.pip-mount video.media-element')).toHaveCount(1)
    await expect(page.locator('.theater-main')).toHaveAttribute('data-role', 'official')

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
      const video = document.querySelector<HTMLVideoElement>('.theater-main video')
      if (video) video.dataset.e2eMark = 'original-main'
    })

    await page.locator('.pip-swap').click()
    await expect(page.locator('.theater-main')).toHaveAttribute('data-role', 'commentary')
    await expect(page.locator('.pip-mount video')).toHaveAttribute(
      'data-e2e-mark',
      'original-main',
    )
    await expect(page.locator('.pip-mount video')).toHaveAttribute('data-role', 'official')
  })

  test('手动偏移把解说回退到指定位置', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)

    // Away from 0 so both sides have rewind head-room in either direction.
    await seekBoth(page, 12, 12)
    await setPlaying(page, false)

    const before = await mediaTimes(page)
    const alignment = page.getByRole('group', { name: '对齐', exact: true })

    // 快进画面 rewinds the commentary side (negative offset), so official − commentary grows.
    await alignment.getByRole('button', { name: '快进画面', exact: true }).click()
    await alignment.getByRole('button', { name: '快进画面', exact: true }).click()

    await expect
      .poll(async () => (await offsetReadout(page)).requested, { timeout: 15_000 })
      .toBeCloseTo(-1, 2)
    await expect
      .poll(async () => (await mediaTimes(page)).lag, { timeout: 15_000 })
      .toBeGreaterThan(before.lag + 0.6)

    // 目标 and 实际 agree here: a VOD fixture at t=12 has the head-room to absorb it.
    const readout = await offsetReadout(page)
    expect(readout.applied).toBeCloseTo(-1, 1)
    await expect(alignment).not.toHaveAttribute('data-state', 'short')

    await alignment.locator('.capsule-readout').click()
    await page.getByRole('dialog', { name: '输入延后时间' }).getByRole('button', { name: '清零', exact: true }).click()
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
    await closeSourceDialog(page)
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

    await connectDanmaku(page)

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

  test('指针停在底栏上时底栏不隐藏, 离开后照常隐藏', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)
    await revealOverlay(page)
    const row = (await page.locator('.dock-row').boundingBox())!
    // Still on the bar for longer than the 3.2 s idle timeout.
    await page.mouse.move(row.x + row.width / 2, row.y + 4)
    await page.waitForTimeout(4500)
    await expect(page.locator('.theater')).toHaveAttribute('data-chrome', 'on')
    await page.mouse.move(row.x + row.width / 2, 200)
    await expect(page.locator('.theater')).toHaveAttribute('data-chrome', 'off', { timeout: 6000 })
  })

  test('窄窗口下底栏各组不重叠', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    for (const width of [1440, 1100, 960, 800]) {
      await page.setViewportSize({ width, height: 700 })
      await revealOverlay(page)
      const groups = await page.evaluate(() => ['.dock-left', '.dock-center', '.dock-right'].map((selector) => {
        const items = [...document.querySelectorAll(`${selector} > *`)].map((node) => node.getBoundingClientRect())
        return { l: Math.min(...items.map((r) => r.left)), r: Math.max(...items.map((r) => r.right)),
          t: Math.min(...items.map((r) => r.top)), b: Math.max(...items.map((r) => r.bottom)) }
      }))
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const [a, b] = [groups[i]!, groups[j]!]
        expect(a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1, `宽 ${width} 时第 ${i + 1}、${j + 1} 组重叠`).toBe(false)
      }
    }
  })

  test('关闭弹幕后立即清空画面', async ({ page, electronApp }) => {
    await stubDanmakuStream(electronApp, ['要被清掉的弹幕', '第二条', '第三条'])
    await openPlayer(page)
    await loadBothFixtures(page)
    await seekBoth(page, 3, 3)
    await setPlaying(page, true)

    await connectDanmaku(page)
    await expect(page.locator('.danmaku-item').first()).toBeVisible({ timeout: 20_000 })

    // The wait above outlasts the overlay's idle timeout, so bring the bar back first.
    await revealOverlay(page)
    await page.locator('.dock').getByRole('button', { name: '弹', exact: true }).click()
    await expect(page.locator('.danmaku-item')).toHaveCount(0)
  })
})

test.describe('片源画质和摄像头入口', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('全屏时摄像头取景对话框仍可打开和关闭', async ({ page }, testInfo) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await revealOverlay(page)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    const dialog = await openCameraFraming(page)
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

    const dialog = await openCameraFraming(page)
    // The default rough box (x .02 y .4 w .16 h .2) covers the fixture camera at 64,400
    // 256x144 on 1280x720 only partly; grow it past the camera's right and bottom edges the
    // way a user would, then check the size label says it is now loose all round.
    await dialog.locator('.roi-window').focus()
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowRight')
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowDown')
    const [roughW, roughH] = ((await dialog.locator('.roi-size').textContent()) ?? '').split('×').map(Number)
    expect(roughW).toBeGreaterThan(300)
    expect(roughH).toBeGreaterThan(270)
    await dialog.getByRole('button', { name: '贴边', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('四条边均已贴合', { timeout: 15_000 })

    // The tightened box, read back off the window's size label (video pixels).
    const size = await dialog.locator('.roi-size').textContent()
    const [w, h] = (size ?? '').split('×').map(Number)
    expect(Math.abs(w! - 256)).toBeLessThanOrEqual(4)
    expect(Math.abs(h! - 144)).toBeLessThanOrEqual(4)

    await dialog.getByRole('button', { name: '保存', exact: true }).click()
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
    await expect(page.locator('.studio')).toBeVisible()
    await loadBothFixtures(page)
    await expect(page.locator('.camera-overlay')).toBeVisible()
    const restored = (await page.locator('.camera-overlay').boundingBox())!
    expect(Math.abs(restored.x - moved.x)).toBeLessThan(4)

    // Hidden from the menu, kept in storage.
    await revealOverlay(page)
    await page.locator('.dock').getByRole('button', { name: '主播摄像头', exact: true }).click()
    await page.getByRole('dialog', { name: '主播摄像头', exact: true }).getByRole('button', { name: '隐藏摄像头小窗', exact: true }).click()
    await expect(page.locator('.camera-overlay')).toHaveCount(0)
  })

  test('HLS 主画面的清晰度在底栏右下角切换', async ({ page }) => {
    test.skip(!hlsFixtureReady(), '缺少 HLS 测试源')
    await openPlayer(page)
    await loadBothFixtures(page, FIXTURES.commentaryHls)

    // The ladder belongs to the HLS source, so make it the main picture — 画质 always drives
    // whatever is on stage.
    await page.locator('.pip-swap').click()
    await expect(page.locator('.theater-main')).toHaveAttribute('data-role', 'commentary')

    // Levels arrive on MANIFEST_PARSED, which is not ordered against the readiness wait.
    // Each side has its own button; the commentary's is the one with a ladder here.
    const button = page.locator('.dock').getByRole('button', { name: '解说清晰度', exact: true })
    await revealOverlay(page)
    await expect(button).toBeVisible({ timeout: 20_000 })
    const dock = await page.locator('.dock-right').boundingBox()
    const at = await button.boundingBox()
    if (!dock || !at) throw new Error('清晰度按钮应位于底栏右侧')
    expect(at.x).toBeGreaterThan(dock.x)
    const panel = page.getByRole('dialog', { name: '解说清晰度', exact: true })
    const open = async (): Promise<void> => {
      await revealOverlay(page)
      await button.click()
      await expect(panel).toBeVisible()
    }
    await open()
    // A second press on the same button closes it.
    await button.click()
    await expect(panel).toBeHidden()
    await open()
    const levels = panel.getByRole('menuitemradio')
    expect(await levels.count()).toBeGreaterThan(1)
    // Pick a fixed level, then back to 自动; the button shows its side's choice.
    await levels.nth(1).click()
    await expect(panel).toBeHidden()
    await expect(button).not.toContainText('自动')
    await open()
    await expect(levels.nth(1)).toHaveAttribute('aria-checked', 'true')
    await panel.getByRole('menuitemradio', { name: '自动' }).click()
    await expect(button).toContainText('自动')
    await open()

    // The menu stays within the player surface.
    const box = await panel.boundingBox()
    const stage = await page.locator('main.theater').boundingBox()
    expect(box).not.toBeNull()
    expect(stage).not.toBeNull()
    if (!box || !stage) throw new Error('片源面板应具有可见尺寸')

    expect(box.y).toBeGreaterThanOrEqual(stage.y)
    expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)

    // Escape dismisses it, so the menu never traps a keyboard user inside the overlay.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
