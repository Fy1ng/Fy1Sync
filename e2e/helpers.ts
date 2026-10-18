/**
 * Shared E2E helpers.
 *
 * Two things every spec here needs and neither Playwright nor the app provides:
 *
 *  - **Fixture awareness.** `public/test-sources/` is ffmpeg output and is not committed,
 *    so the media specs must skip rather than fail on a clean checkout. `fixturesReady()`
 *    is checked in a `beforeAll`, not inside a test, so a skip reads as "fixtures missing"
 *    instead of "assertion passed vacuously".
 *
 *  - **Reading real playback state.** Sync correctness is a number, not a rendering. The
 *    sidebar rounds to two decimals and the elements are owned by MediaEngine, so the
 *    assertions read `currentTime` off the actual elements through `mediaTimes()`.
 *
 * The admin token comes from `playwright.config.ts` (`STREAM_SYNC_ADMIN_TOKEN`) and is a
 * test value, not a secret.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, type Locator, type Page } from '@playwright/test'

export const ADMIN_TOKEN = 'e2e-admin-token'

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
  await page.goto('/')
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
 * Answer `/api/danmaku/douyu/:room` with a canned SSE stream.
 *
 * The relay's upstream is Douyu's own socket, so a test that connected for real would
 * depend on a third party being up and on a room being live. Stubbing at the network edge
 * keeps every layer the overlay depends on real — EventSource framing, the session's
 * ingest, the timeline's scheduling against the commentary playhead, lane allocation.
 *
 * The body ends without closing the connection cleanly, so EventSource will try to
 * reconnect; each retry re-serves the same messages, which is harmless here and keeps the
 * overlay populated for the length of the test.
 */
export async function stubDanmakuStream(page: Page, texts: string[]): Promise<void> {
  const body = [
    'event: state\ndata: {"room":"288016","state":"connected"}\n\n',
    ...texts.map(
      (text, index) =>
        `event: danmaku\ndata: ${JSON.stringify({
          id: `stub-${index}`,
          text,
          user: `观众${index}`,
          color: '#ffffff',
        })}\n\n`,
    ),
  ].join('')

  await page.route('**/api/danmaku/douyu/**', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
      body,
    })
  })
}
