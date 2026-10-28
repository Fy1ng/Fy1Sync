/** Shared fixture media helpers; playback and all app IPC remain real. */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { DesktopMethod, DesktopMethods } from '../electron/contracts'
import type { ApiResult } from '../src/app/apiClient'
import type { ChatMessage } from '../server/danmaku/types'
import type { DouyuTaskKind } from '../server/douyu/types'
import { SETTINGS_KEY } from '../src/app/settings'
import { APP_ORIGIN, expect } from './electron'

/** Use the actual preload bridge, retaining the transport result wrapper. */
export async function invoke<K extends DesktopMethod>(
  page: Page,
  method: K,
  args: DesktopMethods[K]['args'],
): Promise<ApiResult<DesktopMethods[K]['result']>> {
  return page.evaluate(({ method, args }) => {
    if (!window.streamSyncer) throw new Error('Electron preload bridge is missing')
    return window.streamSyncer.invoke(method, args)
  }, { method, args })
}

/** Ground truth from `scripts/generate-test-sources.mjs`: commentary trails official by 5 s. */
export const FIXTURE_DELAY_SECONDS = 5

/** v0.4 sync gates. Detection is the estimate, divergence is what verification measured. */
export const MAX_DETECTION_ERROR_SECONDS = 0.25
export const MAX_DIVERGENCE_SECONDS = 0.35

export const FIXTURES = {
  official: '/test-sources/official.mp4',
  commentary: '/test-sources/commentary.mp4',
  commentaryHls: '/test-sources/commentary-hls/index.m3u8',
  profile: '/test-sources/fixture-profile.json',
} as const

const fixtureDir = fileURLToPath(new URL('../public/test-sources/', import.meta.url))

/** True when `npm run fixtures` has been run on this machine. */
export function fixturesReady(): boolean {
  return ['official.mp4', 'commentary.mp4', 'fixture-profile.json'].every((name) =>
    existsSync(`${fixtureDir}${name}`),
  )
}

export function hlsFixtureReady(): boolean {
  return existsSync(`${fixtureDir}commentary-hls/index.m3u8`)
}

/**
 * Fail a spec on the first uncaught page error.
 *
 * Without this a React render crash shows up as a confusing timeout on some later
 * selector, several steps away from the actual break.
 */
export function failOnPageError(page: Page): void {
  page.on('pageerror', (error) => {
    throw new Error(`页面抛出异常：${error.message}`)
  })
}

/** Open the player and wait for the shell, dismissing the cold-start source dialog. */
export async function openPlayer(page: Page): Promise<void> {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/')
  await expect(page.locator('.studio')).toBeVisible()
  await expect(sourceDialog(page)).toBeVisible()
  await closeSourceDialog(page)
}

/**
 * The player with 斗鱼写操作 already on, for scenarios that exercise sending, mute, gifts or
 * tasks against the offline fixtures. The switch itself is covered through the UI elsewhere.
 */
export async function openPlayerWithDouyuWrites(page: Page): Promise<void> {
  await page.goto(APP_ORIGIN + '/')
  await page.evaluate(key => {
    const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...stored, douyuWrites: true }))
  }, SETTINGS_KEY)
  await openPlayer(page)
}

export function sourceDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: '添加直播间' })
}

export async function openSourceDialog(page: Page): Promise<Locator> {
  const dialog = sourceDialog(page)
  if (!(await dialog.isVisible())) {
    // In the player 添加直播间 comes back only from its own button, shown while both sides are empty.
    await page.getByRole('button', { name: '添加直播间', exact: true }).click()
  }
  await expect(dialog).toBeVisible()
  return dialog
}

export async function closeSourceDialog(page: Page): Promise<void> {
  const dialog = sourceDialog(page)
  // The cold-start dialog opens from an effect, so it may not be up on the first paint.
  if (await dialog.isVisible().catch(() => false)) {
    const dismiss = dialog.getByRole('button', { name: /^(跳过|开始观看)$/ })
    if (await dismiss.isVisible()) await dismiss.click()
    await expect(dialog).toBeHidden()
  }
}

/** A loaded source is edited from its top-bar popover. */
export function rolePanel(dialog: Locator, role: 'official' | 'commentary'): Locator {
  return dialog.page().getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
}

/** Respect usePopover's 120 ms outside-dismiss suppression before a new trigger click. */
async function openPopoverTrigger(trigger: Locator): Promise<void> {
  await trigger.page().waitForTimeout(150)
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

export async function openSourcePanel(page: Page, role: 'official' | 'commentary'): Promise<Locator> {
  await closeSourceDialog(page)
  const panel = rolePanel(sourceDialog(page), role)
  if (!(await panel.isVisible())) {
    await revealOverlay(page)
    await openPopoverTrigger(page.locator(`.chip[data-role="${role}"]`))
  }
  await expect(panel).toBeVisible()
  return panel
}

/** Add a source through intake while it is up, otherwise in that side's popover. */
export async function loadSource(
  page: Page,
  role: 'official' | 'commentary',
  url: string,
  timeout = 45_000,
): Promise<void> {
  const chip = page.locator(`.chip[data-role="${role}"]`)
  if (await sourceDialog(page).isVisible()) {
    const dialog = sourceDialog(page)
    await dialog.getByRole('textbox', { name: '直播间链接' }).fill(url)
    await dialog.getByRole('textbox', { name: '直播间链接' }).press('Enter')
    const platform = dialog.getByRole('group', { name: '选择房间号所属平台' })
    if (await platform.isVisible()) await platform.getByRole('button', { name: '斗鱼', exact: true }).click()
    const placement = dialog.getByRole('group', { name: '选择添加位置' })
    if (await placement.isVisible()) await placement.getByRole('button', { name: role === 'official' ? '画面' : '解说', exact: true }).click()
  } else {
    const panel = rolePanel(sourceDialog(page), role)
    if (!(await panel.isVisible())) {
      await revealOverlay(page)
      await openPopoverTrigger(chip)
    }
    await expect(panel).toBeVisible()
    await panel.getByRole('textbox', { name: role === 'official' ? '画面链接' : '解说链接' }).fill(url)
    await panel.getByRole('button', { name: '载入', exact: true }).click()
    await expect(panel).toBeHidden({ timeout })
  }
  await expect(chip).not.toHaveAttribute('data-status', /^(empty|loading)$/, { timeout })
  await closeSourceDialog(page)
  if (role === 'commentary' && process.env.STREAM_SYNC_S2_RECOGNITION) {
    await openCameraFraming(page)
    await page.getByRole('dialog', { name: '摄像头小窗', exact: true }).getByRole('button', { name: '保存', exact: true }).click()
    if (process.env.STREAM_SYNC_S2_RECOGNITION === 'quality') {
      await revealOverlay(page)
      await openPopoverTrigger(page.locator('.dock').getByRole('button', { name: '主播摄像头', exact: true }))
      await setCheckedByLabel(page.getByRole('radiogroup', { name: '摄像头超分' }).getByRole('radio', { name: '画质', exact: true }))
      await page.keyboard.press('Escape')
      await expect(page.locator('.camera-overlay')).toHaveAttribute('data-upscale-tier', 'quality')
    }
    await expect(page.locator('.camera-overlay')).toHaveAttribute('data-upscale-mode', 'webgpu')
  }
}

/** 设置 opens from its gear: in the top bar while the chat is closed, in the chat header otherwise. */
export async function openSettingsSection(page: Page, section: '通用' | '斗鱼' | '弹幕记录' | '房间数据' | '倒计时样式'): Promise<Locator> {
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  if (!(await settings.isVisible())) {
    await closeSourceDialog(page)
    await revealOverlay(page)
    await page.getByRole('button', { name: '设置', exact: true }).first().click()
  }
  await expect(settings).toBeVisible()
  await settings.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: section, exact: true }).click()
  return settings
}

/** 通用 in 设置, on one of its pages (YouTube, 对齐, 解码, 画中画, 截图与 GIF, 取流工具, 关于). */
export async function openSettings(page: Page, pageName = 'YouTube'): Promise<Locator> {
  const settings = await openSettingsSection(page, '通用')
  await settings.getByRole('tablist', { name: '通用' }).getByRole('tab', { name: pageName, exact: true }).click()
  return settings
}

/** The 斗鱼 section of 设置; its pages are vertical tabs down the left. */
export async function openDouyuDesk(page: Page): Promise<Locator> {
  return openSettingsSection(page, '斗鱼')
}

export async function openDouyuTab(page: Page, tab: string): Promise<Locator> {
  const desk = await openDouyuDesk(page)
  await desk.getByRole('tablist', { name: '斗鱼' }).getByRole('tab', { name: new RegExp('^' + tab) }).click()
  return desk
}

/** Studio switches and segmented radios are clicked through their visible labels. */
export async function setCheckedByLabel(input: Locator, checked = true): Promise<void> {
  await expect(input).toBeEnabled()
  if (await input.isChecked() !== checked) await input.locator('..').click()
  await expect(input).toBeChecked({ checked })
}

/** Open the ordinary task form; creating remains a separate explicit UI action. */
export async function openTaskForm(page: Page, kind: DouyuTaskKind, room: string, daily = false): Promise<Locator> {
  const desk = await openDouyuTab(page, '房间任务')
  await desk.getByRole('button', { name: '新任务', exact: true }).click()
  const form = desk.locator('.new-form')
  const names: Record<DouyuTaskKind, string> = {
    'room-sign': '直播间签到', 'yuba-sign': '鱼吧签到', 'message-loop': '定时弹幕',
    'auto-fish': '钓鱼', 'gift-packet': '抢红包', 'treasure-box': '开宝箱',
  }
  await setCheckedByLabel(form.getByRole('radiogroup', { name: '任务类型', exact: true }).getByRole('radio', { name: names[kind], exact: true }))
  await form.getByRole('textbox', { name: '任务房间号或地址', exact: true }).fill(room)
  await setCheckedByLabel(form.getByRole('radiogroup', { name: '执行条件', exact: true }).getByRole('radio', { name: '锁屏时也运行', exact: true }))
  if (daily) await setCheckedByLabel(form.getByRole('switch', { name: '每天签到一次', exact: true }))
  return form
}

export async function openDanmakuSettings(page: Page): Promise<Locator> {
  const panel = page.getByRole('complementary', { name: '弹幕设置' })
  if (!(await panel.isVisible())) {
    await revealOverlay(page)
    await page.getByRole('button', { name: '弹幕设置', exact: true }).click()
  }
  await expect(panel).toBeVisible()
  return panel
}

export async function connectDanmaku(page: Page, room = '288016'): Promise<void> {
  // Chat settings live on a loaded commentary source in the studio.
  if (await page.locator('.chip[data-role="commentary"]').getAttribute('data-status') === 'empty') {
    await loadSource(page, 'commentary', FIXTURES.commentary)
  }
  const panel = await openSourcePanel(page, 'commentary')
  await panel.getByRole('button', { name: /^(连接|更换房间)$/ }).click()
  await panel.getByRole('textbox', { name: '弹幕房间号' }).fill(room)
  await panel.getByRole('button', { name: '连接', exact: true }).click()
  await expect(panel.getByText(new RegExp('房间 ' + room))).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
}

export async function disconnectDanmaku(page: Page): Promise<void> {
  const panel = await openSourcePanel(page, 'commentary')
  await panel.getByRole('button', { name: '更换房间', exact: true }).click()
  await panel.getByRole('button', { name: '断开', exact: true }).click()
  await expect(panel).toContainText('未连接')
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
}

export async function openAlignOptions(page: Page): Promise<Locator> {
  const panel = page.getByRole('dialog', { name: '对齐选项', exact: true })
  if (!(await panel.isVisible())) {
    await revealOverlay(page)
    await openPopoverTrigger(page.getByRole('button', { name: '对齐选项', exact: true }))
  }
  await expect(panel).toBeVisible()
  return panel
}

/** The camera lives in the dock: one press frames it, then a menu offers re-framing. */
export async function openCameraFraming(page: Page): Promise<Locator> {
  await closeSourceDialog(page)
  await revealOverlay(page)
  const first = page.locator('.dock').getByRole('button', { name: '框选主播摄像头', exact: true })
  if (await first.isVisible()) await first.click()
  else {
    await openPopoverTrigger(page.locator('.dock').getByRole('button', { name: '主播摄像头', exact: true }))
    await page.getByRole('dialog', { name: '主播摄像头', exact: true }).getByRole('button', { name: '重新框选', exact: true }).click()
  }
  const dialog = page.getByRole('dialog', { name: '摄像头小窗', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

/** Load both fixtures and wait until each element actually has a duration. */
export async function loadBothFixtures(
  page: Page,
  commentaryUrl: string = FIXTURES.commentary,
): Promise<void> {
  await loadSource(page, 'official', FIXTURES.official)
  await loadSource(page, 'commentary', commentaryUrl)
  await closeSourceDialog(page)
  await waitForBothReady(page)
}

export async function waitForBothReady(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLVideoElement>('video.media-element')).filter(
            (video) => video.readyState >= 2 && Number.isFinite(video.duration),
          ).length,
        ),
      { timeout: 30_000, message: '两个片源都应加载出时长' },
    )
    .toBe(2)
}

export interface MediaTimes {
  official: number
  commentary: number
  /** Positive when commentary is behind official, matching the fixture's own convention. */
  lag: number
  paused: boolean
}

/**
 * Read both playheads in one evaluate, so the two reads are as close to simultaneous as
 * the main thread allows. Reading them in two round trips would add the round-trip time
 * straight into the measured lag.
 */
export async function mediaTimes(page: Page): Promise<MediaTimes> {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video.media-element'))
      .filter(video => video.currentSrc || video.getAttribute('src'))
    const find = (role: string): HTMLVideoElement | undefined =>
      videos.find((video) => video.dataset.role === role)
    const official = find('official')
    const commentary = find('commentary')
    const a = official?.currentTime ?? Number.NaN
    const b = commentary?.currentTime ?? Number.NaN
    return {
      official: a,
      commentary: b,
      lag: a - b,
      paused: videos.length === 0 || videos.some(video => video.paused),
    }
  })
}

/** Drive both elements to a known position without touching the sync machinery. */
export async function seekBoth(page: Page, official: number, commentary: number): Promise<void> {
  await page.evaluate(
    ([wantOfficial, wantCommentary]) => {
      const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video.media-element'))
      for (const video of videos) {
        const target = video.dataset.role === 'official' ? wantOfficial : wantCommentary
        if (typeof target === 'number') video.currentTime = target
      }
    },
    [official, commentary] as const,
  )
  await page.waitForTimeout(400)
}

/** Move the pointer onto the stage and wait for the overlay bar to become interactive. */
export async function revealOverlay(page: Page): Promise<void> {
  await page.locator('main.theater').hover({ position: { x: 20, y: 80 } })
  await expect(page.locator('main.theater')).toHaveAttribute('data-chrome', 'on')
  // The state changes before the 220 ms fade/translation finishes. A mouse click
  // must wait for the real dock to finish moving, not just for its state flag.
  await expect(page.locator('.dock')).toHaveCSS('opacity', '1')
  await expect(page.locator('.dock')).toHaveCSS('pointer-events', 'auto')
  await expect(page.locator('.dock')).toHaveCSS('transform', 'none')
}

export async function setPlaying(page: Page, playing: boolean): Promise<void> {
  const button = page.locator('.dock .play')
  const paused = (await mediaTimes(page)).paused
  if (paused === !playing) return
  // Reveal the overlay bar first. It auto-hides during playback and is `pointer-events:
  // none` while hidden, so a click would land on the video behind it — which is what a
  // real user does too: move the pointer over the picture, then press.
  await revealOverlay(page)
  await button.click()
  await expect.poll(async () => (await mediaTimes(page)).paused, { timeout: 10_000 }).toBe(!playing)
}

/**
 * The capsule names the delayed side and reports any unfulfilled part of the request.
 * These are display-precision values; mediaTimes is the independent playback evidence.
 */
export async function offsetReadout(page: Page): Promise<{ requested: number; applied: number }> {
  const label = await page.locator('.capsule-readout').getAttribute('aria-label') ?? ''
  const magnitude = Number.parseFloat(label.match(/[\d.]+/)?.[0] ?? '0')
  const direction = label.startsWith('解说延后') ? -1 : 1
  const caption = await page.locator('.capsule-caption').innerText()
  const shortfall = Number.parseFloat(caption.match(/相差 ([\d.]+)s/)?.[1] ?? '0')
  return { requested: direction * magnitude || 0, applied: direction * (magnitude - shortfall) || 0 }
}

/**
 * Inject deterministic events at the main-process relay edge, never in the renderer.
 * The test-only main hook is absent without STREAM_SYNC_E2E=1. Actual preload event
 * delivery, subscription cleanup, session ingest and media scheduling stay exercised.
 */
export async function stubDanmakuStream(application: ElectronApplication, texts: string[]): Promise<void> {
  await application.evaluate((_electron, messages) => {
    const main = globalThis as typeof globalThis & {
      __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number }
    }
    if (!main.__streamSyncerTest) throw new Error('Main-process E2E relay hook is unavailable')
    let sequence = 0
    const emit = () => {
      main.__streamSyncerTest?.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
      for (const [index, text] of messages.entries()) {
        main.__streamSyncerTest?.emitDanmaku('288016', 'danmaku', {
          id: 'stub-' + sequence + '-' + index,
          text,
          username: '观众' + index,
          color: 0,
          level: 0, receivedAt: Date.now(), room: '288016', system: false,
        } satisfies ChatMessage)
      }
      sequence += 1
    }
    emit()
    // Continue after the room is connected; the process owns and clears this timer.
    setInterval(emit, 800)
  }, texts)
}

/**
 * Stress generator: `perSecond` distinct messages a second into the real relay, through the
 * main-process E2E hook (absent outside the harness, so nothing like this ships). Returns
 * a stop function. Runs in main so the rate does not depend on the renderer keeping up.
 */
export async function stressDanmaku(application: ElectronApplication, perSecond: number): Promise<() => Promise<void>> {
  await application.evaluate((_electron, rate) => {
    const main = globalThis as typeof globalThis & {
      __streamSyncerTest?: { emitDanmaku(room: string, event: string, data: unknown): number }
      __stressTimer?: ReturnType<typeof setInterval>
    }
    if (!main.__streamSyncerTest) throw new Error('Main-process E2E relay hook is unavailable')
    main.__streamSyncerTest.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
    let sequence = 0
    const tickMs = 50
    const perTick = rate * tickMs / 1000
    let carry = 0
    main.__stressTimer = setInterval(() => {
      carry += perTick
      for (; carry >= 1; carry -= 1) {
        sequence += 1
        main.__streamSyncerTest?.emitDanmaku('288016', 'danmaku', {
          id: 'stress-' + sequence, text: '压测弹幕 #' + sequence, username: '观众' + (sequence % 97), color: 0,
          level: 0, receivedAt: Date.now(), room: '288016', system: false,
        } satisfies ChatMessage)
      }
    }, tickMs)
  }, perSecond)
  return async () => {
    await application.evaluate(() => {
      const main = globalThis as typeof globalThis & { __stressTimer?: ReturnType<typeof setInterval> }
      clearInterval(main.__stressTimer)
    })
  }
}
