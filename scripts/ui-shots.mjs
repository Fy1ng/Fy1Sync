/**
 * Launch and screenshot the built Electron app so UI work can be judged by looking at it.
 *
 * Not part of the test suite and not a check — it asserts nothing. It exists because
 * reading CSS is a bad way to find out that two panels disagree about their corner radius.
 *
 *   npm run build
 *   node scripts/ui-shots.mjs [--out path]
 *   STREAM_SYNC_SHOTS_DIR also selects an output directory, including outside the repo.
 *
 * Selectors are the ones e2e/helpers.ts already uses to drive this app; keep the two in
 * step. Every capture is wrapped so a step that cannot reach its state warns and the rest
 * of the sheet still gets taken — a half-populated sheet is more useful than an exception.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from '@playwright/test'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const base = 'app://app'
const root = fileURLToPath(new URL('../', import.meta.url))
const applications = new WeakMap()
const outDir = resolve(flag('out', process.env.STREAM_SYNC_SHOTS_DIR || '.ui-shots'))

/** Desktop is the design target; narrow is where the sidebar and the bar start to fight. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 1024, height: 700 },
]

const FIXTURES = {
  official: '/test-sources/official.mp4',
  commentary: '/test-sources/commentary.mp4',
}

const DANMAKU = [
  '这波指挥有问题',
  '哈哈哈哈哈哈',
  '解说说得对',
  '666666',
  'A队要翻盘了',
  '前面的挡住了',
  '这枪法太离谱',
  '关注主播抽奖',
]

const sourceDialog = (page) => page.getByRole('dialog', { name: '片源设置' })

async function closeSourceDialog(page) {
  const dialog = sourceDialog(page)
  // The cold-start dialog opens from an effect, so it may not be up on the first paint.
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: '完成' }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
}

async function openSourceDialog(page) {
  const dialog = sourceDialog(page)
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: '片源设置' }).click()
  }
  await dialog.waitFor({ state: 'visible' })
  return dialog
}

/** The role panel inside the source dialog, addressed by its heading. */
function rolePanel(dialog, role) {
  return dialog.locator('.source-panel', {
    has: dialog.page().getByRole('heading', { name: role === 'official' ? '官方画面' : '解说' }),
  })
}

async function loadSource(page, role, url) {
  const dialog = await openSourceDialog(page)
  const panel = rolePanel(dialog, role)
  // By label, not by role alone: the commentary panel also carries the danmaku room field.
  await panel.getByRole('textbox', { name: '直播间或媒体地址' }).fill(url)
  await panel.getByRole('button', { name: '加载' }).click()
  await panel
    .locator('.source-current')
    .filter({ hasText: url.split('/').pop() })
    .waitFor({ timeout: 20_000 })
}

/** Both elements have a real duration — otherwise the stage screenshots are black. */
async function waitForBothReady(page) {
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('video.media-element')).filter(
        (video) => video.readyState >= 2 && Number.isFinite(video.duration),
      ).length === 2,
    undefined,
    { timeout: 30_000 },
  )
}

/** The bar auto-hides and is pointer-events:none while hidden, so reveal before clicking. */
async function revealOverlay(page) {
  await page.locator('.stage').hover({ position: { x: 20, y: 20 } })
  await page.locator('.overlay-bar.is-visible').waitFor()
}

/** Test-mode main injection keeps screenshot danmaku offline. */
async function stubDanmaku(page) {
  const application = applications.get(page)
  await application.evaluate((_electron, texts) => {
    const hook = globalThis.__streamSyncerTest
    if (!hook) throw new Error('Missing screenshot test hook')
    let batch = 0
    setInterval(() => {
      hook.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
      for (const [index, text] of texts.entries()) hook.emitDanmaku('288016', 'danmaku', {
        id: 'shot-' + batch + '-' + index, text, username: '测试观众' + index,
        color: index % 7, level: 20 + index, receivedAt: Date.now(), room: '288016', system: false,
        sender: { uid: String(1000 + index), level: 20 + index, nobleLevel: 0 },
      })
      if (batch % 4 === 0) hook.emitDanmaku('288016', 'danmaku', {
        id: 'shot-gift-' + batch, text: '粉丝荧光棒 x 3', username: '测试观众1',
        color: 0, level: 21, receivedAt: Date.now(), room: '288016', system: true,
        sender: { uid: '1001', level: 21, nobleLevel: 0 }, gift: { kind: 'prop', id: '268', count: 3 },
      })
      batch++
    }, 250)
  }, DANMAKU)
}

let taken = 0
let failed = 0

async function shot(page, name) {
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  taken += 1
  console.log(`  ✓ ${file}`)
}

/** A capture that cannot reach its state should not take the rest of the sheet with it. */
async function step(name, run) {
  try {
    await run()
  } catch (error) {
    failed += 1
    console.warn(`  ✗ ${name}: ${String(error).split('\n')[0]}`)
  }
}

async function captureViewport(browser, viewport) {
  const prefix = viewport.name
  console.log(`\n${prefix} ${viewport.width}×${viewport.height}`)

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    // The real Electron window retains the host display's native scale.
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => { failed++; console.warn(`  ! 页面异常: ${error.message}`) })
  await stubDanmaku(page)

  await page.goto(base + '/')
  await page.locator('.player-page').waitFor({ timeout: 30_000 })

  // Cold start: the dialog is the first thing anyone sees, so it is the first thing to look at.
  await step('cold', async () => {
    await sourceDialog(page).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(300)
    await shot(page, `${prefix}-01-cold-dialog`)
  })

  await step('empty', async () => {
    await closeSourceDialog(page)
    await page.waitForTimeout(300)
    await shot(page, `${prefix}-02-empty-stage`)
  })

  await step('loaded', async () => {
    await loadSource(page, 'official', FIXTURES.official)
    await loadSource(page, 'commentary', FIXTURES.commentary)
    await shot(page, `${prefix}-03-dialog-loaded`)
    await closeSourceDialog(page)
    await waitForBothReady(page)
    await page.waitForTimeout(500)
    await shot(page, `${prefix}-04-loaded`)
  })

  await step('overlay', async () => {
    await revealOverlay(page)
    await page.waitForTimeout(200)
    await shot(page, `${prefix}-05-overlay`)
  })

  // A DropUp with its menu open. Not 画质: a progressive mp4 exposes one level, so OverlayBar
  // disables that trigger and it cannot be opened here at all. The sidebar's 小步长 is the same
  // component and is always enabled — and it is the sidebar shape of the control, which is the
  // one that has to sit convincingly among the sidebar's rows.
  // The name is anchored: an accessible name is label + value, so a bare /画质/ matches 摄像头画质 too.
  await step('dropup menu', async () => {
    await revealOverlay(page)
    await page.getByRole('button', { name: /^小步长/ }).click()
    await page.waitForTimeout(250)
    await shot(page, `${prefix}-06-dropup-menu`)
    await page.keyboard.press('Escape')
  })

  // The camera framing dialog after tightening, then the overlay it produces.
  await step('camera', async () => {
    await revealOverlay(page)
    await page.locator('.overlay-bar').getByRole('button', { name: /^摄像头/ }).click()
    await page.getByRole('option', { name: /框选摄像头|重新取景/ }).click()
    const dialog = page.getByRole('dialog', { name: '摄像头小窗取景' })
    await dialog.locator('.roi-window').focus()
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowRight')
    for (let n = 0; n < 12; n += 1) await page.keyboard.press('Alt+Shift+ArrowDown')
    await dialog.getByRole('button', { name: /自动收紧|重新收紧/ }).click()
    await dialog.getByRole('status').waitFor({ timeout: 15_000 })
    await shot(page, `${prefix}-11-camera-dialog`)
    await dialog.getByRole('button', { name: '保存并显示' }).click()
    await page.locator('.camera-overlay').waitFor()
    await page.waitForTimeout(400)
    await shot(page, `${prefix}-12-camera-overlay`)
  })

  await step('danmaku panel', async () => {
    await revealOverlay(page)
    await page.getByRole('button', { name: '弹幕设置' }).click()
    await page.locator('.danmaku-panel').waitFor()
    await page.waitForTimeout(300)
    await shot(page, `${prefix}-07-danmaku-settings`)
    await page.getByRole('button', { name: /^屏蔽正则/ }).click()
    await page.waitForTimeout(500)
    await shot(page, `${prefix}-08-danmaku-filter`)
    await page.getByRole('button', { name: '返回' }).click()
    await page.getByRole('button', { name: '关闭弹幕设置' }).click()
  })

  await step('danmaku overlay', async () => {
    const dialog = await openSourceDialog(page)
    const panel = rolePanel(dialog, 'commentary')
    await panel.getByRole('textbox', { name: '弹幕房间号' }).fill('288016')
    await panel.getByRole('button', { name: '连接' }).click()
    await closeSourceDialog(page)
    await revealOverlay(page)
    await page.locator('.play-button').click()
    // Long enough for the lanes to fill and the first tracks to travel a visible distance.
    await page.waitForTimeout(2500)
    await shot(page, `${prefix}-09-danmaku-live`)
  })

  await step('fullscreen', async () => {
    await revealOverlay(page)
    await page.getByRole('button', { name: '全屏' }).click()
    await page.waitForTimeout(600)
    await revealOverlay(page)
    await shot(page, `${prefix}-10-fullscreen`)
  })

  await context.close()
}

/** The Profile Editor is its own page and shares only the stylesheet, so it drifts easily. */
async function captureAdmin(browser) {
  console.log('\nadmin 1440×900')
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => { failed++; console.warn(`  ! 页面异常: ${error.message}`) })

  await step('admin', async () => {
    await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    await shot(page, 'admin-01-gate')
  })

  // A screenshot sample with the fixture's ROI, so the inspector column is populated.
  await step('admin screenshot', async () => {
    const frame = fileURLToPath(new URL('../public/test-sources/frame-0-20.png', import.meta.url))
    await page.locator('.stage-toolbar input[accept^="image/"]').setInputFiles(frame)
    await page.locator('img.admin-video').waitFor()
    await page.waitForTimeout(600)
    await shot(page, 'admin-02-screenshot')
  })

  await context.close()
}

async function main() {
  await mkdir(outDir, { recursive: true })

  const runtimeRoot = resolve(root, '.runtime-cache', 'ui-shots')
  const runtime = join(runtimeRoot, 'runtime-' + randomUUID())
  await mkdir(runtime, { recursive: true })
  const active = new Set()
  // Each capture owns a real app and a disposable profile; the adapter preserves the
  // existing screenshot steps without depending on a separately running server.
  const browser = {
    async newContext({ viewport }) {
      const profile = join(runtime, randomUUID())
      const temporary = join(profile, 'temp')
      await mkdir(temporary, { recursive: true })
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
        && !/^STREAM_SYNC_/i.test(name) && !/^ELECTRON_RUN_AS_NODE$/i.test(name)))
      Object.assign(env, { STREAM_SYNC_E2E: '1', STREAM_SYNC_OFFLINE_E2E: '1',
        STREAM_SYNC_USER_DATA_DIR: profile, STREAM_SYNC_DATA_DIR: join(profile, 'data'), TEMP: temporary, TMP: temporary })
      const application = await _electron.launch({ args: [join(root, 'dist/electron/main.cjs')], cwd: root, env })
      active.add(application)
      // The window exists only once the first page is up; resizing before that finds none.
      const page = await application.firstWindow()
      // Let the app finish its own first navigation, or a later goto aborts against it.
      await page.waitForURL(base + '/**', { timeout: 30_000 })
      await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function')
      await application.evaluate(() => {
        const hook = globalThis.__streamSyncerTest
        if (!hook?.setDouyuRoomFixture) throw new Error('Offline room identity fixture is unavailable')
        hook.setDouyuRoomFixture({ '288016': '288016' })
      })
      await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), viewport)
      applications.set(page, application)
      return { newPage: async () => page, close: async () => { await application.close(); active.delete(application) } }
    },
    async close() {
      const closed = await Promise.allSettled([...active].map(application => application.close()))
      if (closed.some(result => result.status === 'rejected')) throw new Error('截图测试应用未能关闭, 临时 Profile 已保留')
      if (dirname(runtime) !== runtimeRoot || !/^runtime-[a-f0-9-]{36}$/.test(basename(runtime))) throw new Error('Invalid screenshot profile cleanup path')
      await rm(runtime, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    },
  }
  try {
    for (const viewport of VIEWPORTS) await captureViewport(browser, viewport)
    await captureAdmin(browser)
  } finally {
    await browser.close()
  }

  await writeFile(join(outDir, 'capture-report.json'), JSON.stringify({ screenshots: taken, failures: failed, offline: true }, null, 2) + '\n')
  console.log(`\n${taken} 张截图写入 ${outDir}${failed > 0 ? `, ${failed} 项失败` : ''}`)
  if (failed) process.exitCode = 1
}

await main()
