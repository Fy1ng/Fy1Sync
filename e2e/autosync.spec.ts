/**
 * Countdown measurement and strict score rejection, end to end.
 *
 * The sync design commits to a detection error within 0.25 s. The assertions compare
 * numeric results and positions read off the real elements,
 * compared against the fixture's own ground truth — `scripts/generate-test-sources.mjs`
 * renders the same countdown into both files with the commentary delayed exactly 5 s.
 *
 * These fixtures have no team scores. Automatic application must therefore fail without
 * moving the pair or changing playback rates, even after a valid countdown estimate.
 * Successful content alignment is covered separately by the local-recording acceptance.
 *
 * Everything on the path is real: a decoded frame, the worker and template matching.
 * What the spec *builds* is the profile, because template bitmaps are machine
 * specific — a glyph rasterised by this machine's ffmpeg and font stack is the only thing
 * that will match on this machine, which is why `fixture-profile.json` ships with none.
 * The templates are taught through the editor, published, then selected in the player, so
 * the hand-off the deployed page depends on (id in settings → fetch by id) is exercised
 * too rather than stubbed.
 */

import { fileURLToPath } from 'node:url'
import { type Page } from '@playwright/test'
import type { RecognitionProfile } from '../src/core/profileSchema'
import { APP_ORIGIN, expect, launchApplication, test } from './electron'
import {
  invoke,
  FIXTURE_DELAY_SECONDS,
  MAX_DETECTION_ERROR_SECONDS,
  failOnPageError,
  fixturesReady,
  loadBothFixtures,
  loadSource,
  mediaTimes,
  offsetReadout,
  openAlignOptions,
  openPlayer,
  revealOverlay,
  seekBoth,
  setCheckedByLabel,
  setPlaying,
} from './helpers'

const officialPath = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

/** The fixture's ROI, from the generator. */
const ROI = { x: 0.42, y: 0.045, w: 0.16, h: 0.13 }

/** Every character the clock can show, sorted, as the profile stores them. */
const CLOCK_CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':']

/**
 * Where both elements start before a detection run.
 *
 * Late enough that the official element has more than the fixture's 5 s of rewind
 * head-room, since a VOD cannot seek before 0 and the plan would otherwise clamp and
 * report an offset short of the truth. Early enough that neither clock reaches 0:00
 * during a 3 s window plus the settle — a held 0:00 emits no jump for the estimator to
 * anchor on. Official runs 0:08 down here, commentary 0:13.
 */
const START_SECONDS = 12

test.describe('无预设自动同步', () => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  test.setTimeout(180_000)

  test('无预设时独立学习倒计时, 无比分时保持位置与速率', async ({ page }) => {
    const backends: string[] = []
    page.on('worker', worker => worker.on('console', message => {
      const match = /\[识别 Worker\] 后端: (\S+)/.exec(message.text())
      if (match) backends.push(match[1]!)
    }))
    await openPlayer(page)
    const before = await invoke(page, 'listPresets', undefined)
    expect(before.ok).toBe(true)
    if (!before.ok) throw new Error(before.message)
    expect(before.value.presets).toEqual([])
    const options = await openAlignOptions(page)
    await expect(options.getByRole('combobox', { name: '倒计时样式' }).locator('option:checked')).toHaveText('自动识别')
    await page.keyboard.press('Escape')
    await loadSource(page, 'official', '/test-sources/auto-official.mp4')
    await loadSource(page, 'commentary', '/test-sources/auto-commentary.mp4')
    // Leave separate live windows for discovery and native ROI learning, then measurement.
    await seekBoth(page, 0.25, 0.25)
    await setPlaying(page, true)
    await revealOverlay(page)
    await page.getByRole('button', { name: '自动对齐', exact: true }).click()
    // The limits are said over the picture; a found countdown is used without asking.
    await expect(page.locator('.toast').filter({ hasText: '目前自动同步条件较苛刻' })).toBeVisible()
    for (const role of ['official', 'commentary']) {
      const card = page.locator(`.prompt[data-role="${role}"]`)
      await expect(card).toHaveCount(0, { timeout: 60_000 })
      await expect(card.getByRole('button', { name: '使用', exact: true })).toHaveCount(0)
    }
    await waitForPhase(page, '未完成')
    await expect((await openAlignOptions(page)).locator('.menu-meta')).toContainText('没读到比分')
    const times = await mediaTimes(page)
    expect(Math.abs(times.lag)).toBeLessThanOrEqual(0.2)
    expect(await offsetReadout(page)).toMatchObject({ requested: 0, applied: 0 })
    expect(backends.length, '实际识别 Worker 应报告后端').toBeGreaterThan(0)
    expect(new Set(backends)).toEqual(new Set(['wasm']))
    const after = await invoke(page, 'listPresets', undefined)
    expect(after.ok && after.value.presets).toEqual([])
    expect(await page.locator('video.media-element').evaluateAll(videos => videos.map(video => (video as HTMLVideoElement).playbackRate))).toEqual([1, 1])
  })
})

/**
 * Sample times and the digits visible at each, for teaching templates.
 *
 * The fixture's clock is `0:%{eif: max(0, 20 - floor(t)) :d:2}`, so the digit changes on
 * integer `t`; sampling at `x.5` stays clear of the boundary a frame either side of a seek
 * could land on. The first eight cover all eleven characters — the tens digit gives 0 and
 * 1, the units digit sweeps 2..9 — and the rest are second sources for the digits that
 * appear only once up there, since a lesson whose frame segments badly is skipped.
 */
const LESSONS: { at: number; reads: string }[] = [
  { at: 1.5, reads: '0:19' },
  { at: 2.5, reads: '0:18' },
  { at: 3.5, reads: '0:17' },
  { at: 4.5, reads: '0:16' },
  { at: 5.5, reads: '0:15' },
  { at: 6.5, reads: '0:14' },
  { at: 7.5, reads: '0:13' },
  { at: 8.5, reads: '0:12' },
  { at: 11.5, reads: '0:09' },
  { at: 12.5, reads: '0:08' },
  { at: 13.5, reads: '0:07' },
  { at: 14.5, reads: '0:06' },
  { at: 15.5, reads: '0:05' },
  { at: 16.5, reads: '0:04' },
  { at: 17.5, reads: '0:03' },
  { at: 18.5, reads: '0:02' },
]

test.describe('自动同步', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  // Sampling two videos through the worker for a full detection window is genuinely slow;
  // these are also the only tests that prove the feature works.
  test.setTimeout(180_000)

  let presetId = ''
  let presetName = ''
  let taughtProfile: RecognitionProfile | undefined

  // Teach once in another disposable Electron app. Every scenario gets its own app and
  // preset store, seeded with the result of this actual decoded-frame teaching flow.
  test.beforeAll(async () => {
    if (!fixturesReady()) return
    const stamp = Date.now()
    presetId = 'e2e/autosync-' + stamp
    presetName = '自动同步测试场景 ' + stamp
    const running = await launchApplication('autosync-teaching')
    try {
      await teachProfile(running.page, presetId, presetName)
      const fetched = await invoke(running.page, 'getPreset', { id: presetId })
      expect(fetched.ok).toBe(true)
      if (!fetched.ok) throw new Error(fetched.message)
      taughtProfile = fetched.value.profile
    } finally {
      await running.close()
    }
  })

  test.beforeEach(async ({ page }) => {
    if (!taughtProfile) throw new Error('Fixture teaching did not produce a profile')
    const saved = await invoke(page, 'savePreset', { id: presetId, profile: taughtProfile })
    expect(saved.ok).toBe(true)
  })

  test('教出的字形发布后能整套读回', async ({ page }) => {
    const fetched = await invoke(page, 'getPreset', { id: presetId })
    expect(fetched.ok).toBe(true)
    if (!fetched.ok) throw new Error(fetched.message)
    expect(Object.keys(fetched.value.profile.templates).sort()).toEqual(CLOCK_CHARS)
  })

  test('识别出的偏移落在 0.25 s 误差内', async ({ page }) => {
    // The worker silently falls back to the TypeScript engine when WASM cannot load (CSP,
    // missing asset), and the offset would still pass. Pin the backend the run really used.
    const backends: string[] = []
    page.on('worker', worker => worker.on('console', message => {
      const match = /\[识别 Worker\] 后端: (\S+)/.exec(message.text())
      if (match) backends.push(match[1]!)
    }))
    await openPlayer(page)
    await selectPreset(page, presetName)
    await loadBothFixtures(page)

    // Both at the same position: the only difference between the two pictures is the
    // fixture's built-in 5 s delay, so that is what detection must find.
    await seekBoth(page, START_SECONDS, START_SECONDS)
    await setPlaying(page, true)

    const estimate = await measureOnce(page)
    expect(
      Math.abs(estimate - FIXTURE_DELAY_SECONDS),
      `识别偏移 ${estimate.toFixed(2)} s 应接近真实的 ${FIXTURE_DELAY_SECONDS} s`,
    ).toBeLessThanOrEqual(MAX_DETECTION_ERROR_SECONDS)
    expect(backends.length, '识别 Worker 应报告所用后端').toBeGreaterThan(0)
    expect(new Set(backends), '每个识别 Worker 都应使用 WASM 后端').toEqual(new Set(['wasm']))
  })

  test('仅识别不移动播放位置', async ({ page }) => {
    await openPlayer(page)
    await selectPreset(page, presetName)
    await loadBothFixtures(page)
    await seekBoth(page, START_SECONDS, START_SECONDS)
    await setPlaying(page, true)

    const before = await mediaTimes(page)
    await measureOnce(page)
    const after = await mediaTimes(page)

    // A dry run reports and stops. The playheads advance because it is playing, so the
    // claim is about their *difference*, which a seek would have changed.
    expect(Math.abs(after.lag - before.lag)).toBeLessThan(0.2)
    expect(await offsetReadout(page)).toMatchObject({ requested: 0 })
  })

  test('倒计时可读但没有比分时不自动跳转', async ({ page }) => {
    await openPlayer(page)
    await selectPreset(page, presetName)
    await loadBothFixtures(page)
    await seekBoth(page, START_SECONDS, START_SECONDS)
    await setPlaying(page, true)

    await revealOverlay(page)
    await page.getByRole('button', { name: '自动对齐', exact: true }).click()
    await waitForPhase(page, '未完成')
    await expect((await openAlignOptions(page)).locator('.menu-meta')).toContainText('没读到比分')
    expect(Math.abs((await mediaTimes(page)).lag)).toBeLessThan(0.2)
    expect(await offsetReadout(page)).toMatchObject({ requested: 0, applied: 0 })
    expect(await page.locator('video.media-element').evaluateAll(nodes => nodes.map(node => (node as HTMLVideoElement).playbackRate))).toEqual([1, 1])
  })

  test('比分拒绝后手动一动, 定时同步交回给人', async ({ page }) => {
    await openPlayer(page)
    const options = await openAlignOptions(page)
    await setCheckedByLabel(options.getByRole('switch', { name: /^比赛中保持对齐/ }))
    await selectPreset(page, presetName)
    await loadBothFixtures(page)
    await seekBoth(page, START_SECONDS, START_SECONDS)
    await setPlaying(page, true)

    await revealOverlay(page)
    await page.getByRole('button', { name: '自动对齐', exact: true }).click()
    await waitForPhase(page, '未完成')
    const auto = (await offsetReadout(page)).requested
    expect(auto).toBe(0)

    // Nudging is a statement that the user disagrees with the machine, so the scheduler
    // must stop overwriting the result until they ask for it again.
    await page.keyboard.press('Escape')
    await revealOverlay(page)
    await page.getByRole('group', { name: '对齐', exact: true }).getByRole('button', { name: '快进画面', exact: true }).click()
    await expect(await openAlignOptions(page)).toContainText('自动对齐已暂停')
    await expect
      .poll(async () => (await offsetReadout(page)).requested, { timeout: 15_000 })
      .toBeCloseTo(auto - 0.5, 1)
  })

  test('未播放时无预设提示恢复播放且不应用偏移', async ({ page }) => {
    await openPlayer(page)
    await loadBothFixtures(page)
    await setPlaying(page, false)

    // Discovery cannot learn from paused video. Explain this per source.
    await (await openAlignOptions(page)).getByRole('button', { name: '仅测量', exact: true }).click()
    await waitForPhase(page, '未完成')
    await expect(page.locator('.prompt')).toHaveCount(2)
    for (const role of ['official', 'commentary']) {
      await expect(page.locator(`.prompt[data-role="${role}"]`)).toContainText('恢复两路播放')
    }
    expect(await offsetReadout(page)).toMatchObject({ requested: 0, applied: 0 })
  })
})

/**
 * Build a working profile in the editor: ROI, one grabbed frame per lesson, a click per
 * glyph, then publish.
 */
async function teachProfile(page: Page, id: string, name: string): Promise<void> {
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await expect(page.locator('.editor-main')).toBeVisible()

  await setField(page, '标识', id)
  await setField(page, '名称', name)

  await page.locator('main input[accept="video/*"]').setInputFiles(officialPath)
  await expect
    .poll(async () =>
      page.locator('video.editor-media').evaluate((node: HTMLVideoElement) => node.videoWidth),
    )
    .toBeGreaterThan(0)
  await setRoi(page, ROI)

  const learned = new Set<string>()
  for (const lesson of LESSONS) {
    if (CLOCK_CHARS.every((char) => learned.has(char))) break
    const chars = [...lesson.reads]
    if (chars.every((char) => learned.has(char))) continue

    await seekSample(page, lesson.at)
    await page.getByRole('button', { name: '取当前帧' }).click()

    // Segmentation is async, so wait for the boxes rather than for a fixed delay. The count
    // has to be exactly right before anything is labelled: the pad advances one box per
    // click and stops at the end, so a frame that segmented into three boxes would take
    // the fourth label silently onto nothing. A bad frame is skipped, not guessed at —
    // hence the second sources in LESSONS.
    const boxes = page.locator('.glyph-box')
    const segmented = await boxes
      .nth(chars.length - 1)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false)
    if (!segmented || (await boxes.count()) !== chars.length) continue

    // Left to right, the boxes are the characters in reading order.
    await boxes.first().click()
    for (const char of chars) {
      await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
      learned.add(char)
    }
  }

  expect([...learned].sort(), '每个时钟字符都应教到至少一个样本').toEqual(CLOCK_CHARS)

  await page.getByRole('button', { name: '发布到本机' }).click()
  await expect(page.locator('.editor-note.is-info')).toContainText('已发布')
}

/** Choose a published preset in the studio's alignment options. */
async function selectPreset(page: Page, name: string): Promise<void> {
  const options = await openAlignOptions(page)
  const select = options.getByRole('combobox', { name: '倒计时样式' })
  await expect(select).toBeEnabled({ timeout: 20_000 })
  const option = select.getByRole('option', { name, exact: true })
  await expect(option).toBeEnabled()
  const id = await option.getAttribute('value')
  if (!id) throw new Error('倒计时样式必须对应已发布预设')
  const published = await invoke(page, 'getPreset', { id })
  expect(published.ok && Object.keys(published.value.profile.templates).sort()).toEqual(CLOCK_CHARS)
  await select.selectOption(id)
  await expect(select.locator('option:checked')).toHaveText(name)
  await page.keyboard.press('Escape')
}

/** Run the measurement-only action and return its reported offset. */
async function measureOnce(page: Page): Promise<number> {
  await (await openAlignOptions(page)).getByRole('button', { name: '仅测量', exact: true }).click()
  await waitForPhase(page, '未完成')
  await expect((await openAlignOptions(page)).locator('.menu-meta')).toContainText('没读到比分')
  const estimate = await readResult(page, '识别偏移')
  expect(estimate, '应报出一个识别偏移').not.toBeNull()
  return estimate ?? Number.NaN
}

/**
 * Wait for the phase banner, which is the controller's own state machine rendered.
 *
 * On a timeout it reports the on-screen reason as well. Without that, a run that ended
 * `未完成` fails as a bare string mismatch and says nothing about which of the seven
 * failure kinds happened, which is the only part worth knowing.
 */
async function waitForPhase(page: Page, text: string): Promise<void> {
  try {
    const options = await openAlignOptions(page)
    await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 120_000 })
    if (text === '已完成') {
      await expect(page.getByRole('group', { name: '对齐', exact: true })).toHaveAttribute('data-state', 'locked', { timeout: 120_000 })
      await expect(options.locator('.menu-meta')).toContainText('上次测得偏差')
    }
    else await expect(page.getByRole('group', { name: '对齐', exact: true })).toHaveAttribute('data-state', 'failed', { timeout: 120_000 })
  } catch (error) {
    const reason = await page.locator('.align-menu .menu-meta').textContent().catch(() => null)
    if (!reason) throw error
    throw new Error(`${(error as Error).message}\n\n页面给出的原因：${reason}`)
  }
}

/** Read the controller's estimate and verification values from the displayed result. */
async function readResult(page: Page, term: string): Promise<number | null> {
  const options = await openAlignOptions(page)
  const text = await options.locator('.menu-meta').innerText()
  const pattern = term === '校验残差' ? /复核误差\s+([\d.+-]+)/ : /上次测得偏差\s+([\d.+-]+)/
  const value = Number.parseFloat(pattern.exec(text)?.[1] ?? '')
  return Number.isFinite(value) ? value : null
}

async function setField(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name: label, exact: true }).fill(value)
}

async function setRoi(page: Page, roi: { x: number; y: number; w: number; h: number }): Promise<void> {
  const inputs = page.locator('.roi-field input')
  for (const [index, value] of [roi.x, roi.y, roi.w, roi.h].entries()) {
    await inputs.nth(index).fill(String(value))
  }
}

/**
 * Seek the sample element and wait until the editor agrees it got there.
 *
 * The readout is fed from the same `seeked` handler that grabs the frame, so a matching
 * time means the analysis on screen belongs to the position asked for. Waiting on that
 * rather than on a delay also settles the stale-DOM question: two different frames can
 * segment into the same number of boxes, so a box count alone cannot tell them apart.
 */
async function seekSample(page: Page, seconds: number): Promise<void> {
  await page.locator('video.editor-media').evaluate((node: HTMLVideoElement, to: number) => {
    node.currentTime = to
  }, seconds)
  // Compared as a number, not as text: a seek lands on the nearest frame, so 1.5 s can
  // read back as 1.47 s at 30 fps. Half a frame of tolerance is well inside the second
  // the lesson is about.
  await expect
    .poll(
      async () => {
        const text = await page.locator('.editor-time span').first().innerText()
        return Number.parseFloat(text)
      },
      { timeout: 20_000, message: `样片应停在 ${seconds}s` },
    )
    .toBeCloseTo(seconds, 1)
}
