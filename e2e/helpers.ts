/** Shared fixture media helpers; playback and all app IPC remain real. */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { DesktopMethod, DesktopMethods } from '../electron/contracts'
import type { ApiResult } from '../src/app/apiClient'
import type { ChatMessage } from '../server/danmaku/douyuProtocol'
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

/** docs/v0.4 gates. Detection is the estimate, divergence is what verification measured. */
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
  await expect(page.locator('.player-page')).toBeVisible()
  await closeSourceDialog(page)
}

export function sourceDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: '片源设置' })
}

export async function openSourceDialog(page: Page): Promise<Locator> {
  const dialog = sourceDialog(page)
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: '片源设置' }).click()
  }
  await expect(dialog).toBeVisible()
  return dialog
}

export async function closeSourceDialog(page: Page): Promise<void> {
  const dialog = sourceDialog(page)
  // The cold-start dialog opens from an effect, so it may not be up on the first paint.
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: '完成' }).click()
    await expect(dialog).toBeHidden()
  }
}

/** The role panel inside the source dialog, addressed by its heading. */
export function rolePanel(dialog: Locator, role: 'official' | 'commentary'): Locator {
  return dialog.locator('.source-panel', {
    has: dialog.page().getByRole('heading', { name: role === 'official' ? '官方画面' : '解说' }),
  })
}

/** Load a URL into one role through the dialog's address field. */
export async function loadSource(
  page: Page,
  role: 'official' | 'commentary',
  url: string,
): Promise<void> {
  const dialog = await openSourceDialog(page)
  const panel = rolePanel(dialog, role)
  // By label, not by role alone: the commentary panel also carries the danmaku room field,
  // so a bare `getByRole('textbox')` matches two inputs there.
  await panel.getByRole('textbox', { name: '直播间或媒体地址' }).fill(url)
  await panel.getByRole('button', { name: '加载' }).click()
  await expect(panel.locator('.source-current')).toContainText(url.split('/').pop() ?? url, {
    timeout: 20_000,
  })
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
      paused: Boolean(official?.paused || commentary?.paused),
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
  await page.locator('.stage').hover({ position: { x: 20, y: 20 } })
  await expect(page.locator('.overlay-bar')).toHaveClass(/is-visible/)
}

export async function setPlaying(page: Page, playing: boolean): Promise<void> {
  const button = page.locator('.play-button')
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
 * The sidebar's two offset numbers, parsed. 目标 is what was asked for and 实际 is what the
 * seeks achieved; reading them separately is the point of the layout, because a clamped
 * rewind is only visible as a gap between the two.
 */
export async function offsetReadout(page: Page): Promise<{ requested: number; applied: number }> {
  const values = await page.locator('.sync-status .status-grid dd').allInnerTexts()
  const parse = (text: string | undefined): number => Number.parseFloat((text ?? '').replace(/[^\d.+-]/g, ''))
  return { requested: parse(values[0]), applied: parse(values[1]) }
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
