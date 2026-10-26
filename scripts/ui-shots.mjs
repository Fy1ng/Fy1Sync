/**
 * Capture the built Studio and editor in real Electron windows with disposable profiles.
 * Run npm run build first, then npm run shots -- --out <directory>.
 * Each state is reported separately; failed states produce a non-zero exit code.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
if (outIndex >= 0 && (!argv[outIndex + 1] || argv[outIndex + 1].startsWith('--'))) {
  throw new Error('--out 需要指定截图目录')
}
const outDir = resolve(outIndex >= 0 ? argv[outIndex + 1] : process.env.STREAM_SYNC_SHOTS_DIR
  || join(tmpdir(), 'stream-syncer-ui-shots-' + randomUUID()))
const runtimeRoot = resolve(root, '.runtime-cache', 'ui-shots')
const runtime = join(runtimeRoot, 'runtime-' + randomUUID())
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 1024, height: 700 },
]
const DANMAKU = ['这波指挥有问题', '哈哈哈哈哈哈', '解说说得对', '666666', 'A队要翻盘了', '前面的挡住了', '这枪法太离谱']
const results = []
const pageErrors = []
const active = new Set()
let screenshots = 0

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready)
  // Let the panel transition settle without freezing the real media or layout.
  await page.waitForTimeout(200)
  const file = join(outDir, name + '.png')
  await page.screenshot({ path: file })
  screenshots++
  console.log('  已保存 ' + file)
  return file
}

async function dismiss(page) {
  const sheet = page.locator('.sheet[role="dialog"]')
  if (await sheet.isVisible()) await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  const closeDanmaku = page.getByRole('button', { name: '关闭弹幕设置', exact: true })
  if (await closeDanmaku.isVisible()) await closeDanmaku.click()
  await page.keyboard.press('Escape')
}

async function step(page, name, prepare = async () => {}, cleanup = true) {
  const started = Date.now()
  try {
    await prepare()
    const file = await shot(page, name)
    results.push({ name, status: 'passed', file, durationMs: Date.now() - started })
    return true
  } catch (error) {
    const message = String(error).split('\n')[0]
    results.push({ name, status: 'failed', message, durationMs: Date.now() - started })
    console.warn('  失败 ' + name + ': ' + message)
    return false
  } finally {
    if (cleanup) await dismiss(page).catch(() => {})
  }
}

async function reveal(page) {
  await page.locator('main.theater').hover({ position: { x: 20, y: 20 } })
  await page.locator('.theater[data-chrome="on"]').waitFor()
}

async function selectChoice(control) {
  await expect(control).toBeEnabled()
  // Switches and segmented choices expose native inputs but use their labels as targets.
  if (!await control.isChecked()) await control.locator('..').click()
  await expect(control).toBeChecked()
}

async function intake(page) {
  const dialog = page.getByRole('dialog', { name: '添加直播间', exact: true })
  if (!await dialog.isVisible()) {
    await reveal(page)
    await page.getByRole('button', { name: '添加直播间', exact: true }).click()
  }
  await dialog.waitFor()
  return dialog
}

async function sourcePanel(page, role) {
  await reveal(page)
  await page.locator('.topbar .chip[data-role="' + role + '"]').click()
  const panel = page.getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
  await panel.waitFor()
  return panel
}

/** A section of 设置, opened from its gear. */
async function workspace(page, section) {
  const sheet = page.getByRole('dialog', { name: '设置', exact: true })
  if (!(await sheet.isVisible())) {
    await reveal(page)
    await page.getByRole('button', { name: '设置', exact: true }).first().click()
    await sheet.waitFor()
  }
  await sheet.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: section, exact: true }).click()
  return sheet
}

async function launch(viewport) {
  const profile = join(runtime, randomUUID())
  const temporary = join(profile, 'temp')
  await mkdir(temporary, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
    && !/^STREAM_SYNC_/i.test(name) && !/^ELECTRON_RUN_AS_NODE$/i.test(name)))
  Object.assign(env, {
    STREAM_SYNC_E2E: '1', STREAM_SYNC_OFFLINE_E2E: '1',
    STREAM_SYNC_USER_DATA_DIR: profile, STREAM_SYNC_DATA_DIR: join(profile, 'data'),
    TEMP: temporary, TMP: temporary,
  })
  const application = await _electron.launch({
    args: [join(root, 'dist/electron/main.cjs'), '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    cwd: root, env, timeout: 30_000,
  })
  active.add(application)
  const page = await application.firstWindow()
  page.setDefaultTimeout(12_000)
  page.on('pageerror', error => {
    pageErrors.push({ viewport: viewport.name, message: error.message })
    console.warn('  页面异常: ' + error.message)
  })
  page.on('crash', () => {
    pageErrors.push({ viewport: viewport.name, message: '渲染进程崩溃' })
  })
  await page.waitForURL('app://app/**')
  await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function')
  await application.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(size.width, size.height)
  }, viewport)
  await application.evaluate(() => {
    const hook = globalThis.__streamSyncerTest
    if (!hook?.setDouyuRoomFixture) throw new Error('离线房间 fixture 不可用')
    hook.setDouyuRoomFixture({ '288016': '288016' })
  })
  return { application, page }
}

async function startDanmaku(application) {
  await application.evaluate((_electron, texts) => {
    const hook = globalThis.__streamSyncerTest
    if (!hook?.emitDanmaku) throw new Error('离线弹幕 fixture 不可用')
    let batch = 0
    const emit = () => {
      hook.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
      for (const [index, text] of texts.entries()) hook.emitDanmaku('288016', 'danmaku', {
        id: 'shot-' + batch + '-' + index, text, username: '测试观众' + index,
        color: index % 7, level: 20 + index, receivedAt: Date.now(), room: '288016', system: false, dms: 100,
        sender: { uid: String(1000 + index), level: 20 + index, nobleLevel: 0 },
      })
      if (batch % 4 === 0) hook.emitDanmaku('288016', 'danmaku', {
        id: 'shot-gift-' + batch, text: '粉丝荧光棒 x 3', username: '测试观众1',
        color: 0, level: 21, receivedAt: Date.now(), room: '288016', system: true,
        sender: { uid: '1001', level: 21, nobleLevel: 0 }, gift: { kind: 'prop', id: '268', count: 3 },
      })
      batch++
    }
    emit()
    // The process owns the timer and ends with this isolated screenshot profile.
    globalThis.__uiShotsTimer = setInterval(emit, 800)
  }, DANMAKU)
}

async function captureViewport(viewport) {
  console.log('\n' + viewport.name + ' ' + viewport.width + 'x' + viewport.height)
  const { application, page } = await launch(viewport)
  const prefix = viewport.name
  try {
    await page.locator('.studio').waitFor()
    await step(page, prefix + '-01-cold-dialog', async () => { await intake(page) }, false)
    await step(page, prefix + '-02-platform-choice', async () => {
      const dialog = await intake(page)
      await dialog.getByRole('textbox', { name: '直播间链接', exact: true }).fill('6657')
      await dialog.getByRole('textbox', { name: '直播间链接', exact: true }).press('Enter')
      await dialog.getByRole('group', { name: '选择房间号所属平台', exact: true }).waitFor()
    })
    await step(page, prefix + '-03-empty-stage', async () => {
      await page.getByRole('button', { name: '添加直播间', exact: true }).waitFor()
    })
    const loaded = await step(page, prefix + '-04-loaded', async () => {
      const dialog = await intake(page)
      await dialog.getByRole('button', { name: '载入测试片源', exact: true }).click()
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 })
      await page.waitForFunction(() => Array.from(document.querySelectorAll('video.media-element'))
        .filter(video => video.readyState >= 2 && Number.isFinite(video.duration) && !video.paused).length === 2)
      await reveal(page)
    })
    if (!loaded) return
    await step(page, prefix + '-05-source-panel', async () => { await sourcePanel(page, 'commentary') })
    await step(page, prefix + '-06-align-options', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '对齐选项', exact: true }).click()
      await page.getByRole('dialog', { name: '对齐选项', exact: true }).waitFor()
    })
    await step(page, prefix + '-07-offset-editor', async () => {
      await reveal(page)
      await page.locator('.capsule-readout').click()
      await page.getByRole('dialog', { name: '输入延后时间', exact: true }).waitFor()
    })
    const camera = await step(page, prefix + '-08-camera-framing', async () => {
      await reveal(page)
      await page.locator('.dock').getByRole('button', { name: '框选主播摄像头', exact: true }).click()
      const framing = page.getByRole('dialog', { name: '摄像头小窗', exact: true })
      await framing.locator('.roi-window').waitFor()
      await framing.locator('.roi-window').focus()
      for (let n = 0; n < 12; n++) await page.keyboard.press('Alt+Shift+ArrowRight')
      for (let n = 0; n < 12; n++) await page.keyboard.press('Alt+Shift+ArrowDown')
      await framing.getByRole('button', { name: '贴边', exact: true }).click()
      await framing.getByRole('button', { name: '保存', exact: true }).waitFor()
      await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('.framing button'))
        return buttons.some(button => button.textContent === '保存' && !button.disabled)
      })
    }, false)
    if (camera) await step(page, prefix + '-09-camera-overlay', async () => {
      await page.getByRole('dialog', { name: '摄像头小窗', exact: true }).getByRole('button', { name: '保存', exact: true }).click()
      await page.locator('.camera-overlay').waitFor()
    })
    else await dismiss(page)

    const chat = await step(page, prefix + '-10-danmaku-live', async () => {
      const panel = await sourcePanel(page, 'commentary')
      await panel.getByRole('button', { name: '连接', exact: true }).click()
      await panel.getByRole('textbox', { name: '弹幕房间号', exact: true }).fill('288016')
      await panel.getByRole('button', { name: '连接', exact: true }).click()
      await dismiss(page)
      await startDanmaku(application)
      await page.getByRole('log', { name: '弹幕列表', exact: true }).locator('.msg').first().waitFor()
      await page.locator('.danmaku-item').first().waitFor()
      await page.waitForTimeout(800)
      await reveal(page)
    })
    await step(page, prefix + '-11-danmaku-settings', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '弹幕设置', exact: true }).click()
      await page.locator('.float-panel').waitFor()
      await selectChoice(page.getByRole('switch', { name: /^显示礼物消息/ }))
    })
    await step(page, prefix + '-12-danmaku-filter', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '弹幕设置', exact: true }).click()
      const field = page.getByRole('textbox', { name: '添加屏蔽关键词', exact: true })
      await field.fill('广告')
      await field.press('Enter')
      await field.scrollIntoViewIfNeeded()
    })
    await step(page, prefix + '-13-danmaku-processing', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '弹幕设置', exact: true }).click()
      const choices = page.getByRole('radiogroup', { name: '重复弹幕', exact: true })
      await selectChoice(choices.getByRole('radio', { name: '合并计数', exact: true }))
      await page.getByRole('slider', { name: '合并窗口', exact: true }).scrollIntoViewIfNeeded()
    })
    if (chat) await step(page, prefix + '-14-danmaku-menu', async () => {
      // Stop the fixture stream so a row menu stays anchored while captured.
      await application.evaluate(() => { clearInterval(globalThis.__uiShotsTimer) })
      await page.getByRole('log', { name: '弹幕列表', exact: true }).getByRole('button', { name: /^更多操作/ }).last().click()
      await page.getByRole('dialog', { name: /^弹幕操作/ }).waitFor()
    })
    await step(page, prefix + '-15-settings', async () => { await workspace(page, '通用') })
    await step(page, prefix + '-16-capture-settings', async () => {
      const settings = await workspace(page, '通用')
      await settings.getByRole('tablist', { name: '通用' }).getByRole('tab', { name: '截图与 GIF', exact: true }).click()
      const enabled = settings.getByRole('switch', { name: '启用截图与 GIF', exact: true })
      await selectChoice(enabled)
      await enabled.scrollIntoViewIfNeeded()
    })
    await step(page, prefix + '-17-gif-form', async () => {
      await reveal(page)
      await page.getByRole('button', { name: 'GIF 录制', exact: true }).click()
      await page.getByRole('dialog', { name: 'GIF 录制', exact: true }).waitFor()
    })
    await step(page, prefix + '-18-douyu-workspace', async () => { await workspace(page, '斗鱼') })
    await step(page, prefix + '-19-extra-stream-form', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '同屏观看其他直播间', exact: true }).click()
      await page.getByRole('dialog', { name: '同屏观看', exact: true })
        .getByRole('textbox', { name: '直播间房间号或链接', exact: true }).fill('288016')
    })
    await step(page, prefix + '-20-pip-menu', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '画中画', exact: true }).click()
      await page.getByRole('dialog', { name: '画中画', exact: true }).waitFor()
    })
    await step(page, prefix + '-21-fullscreen', async () => {
      await reveal(page)
      await page.getByRole('button', { name: '全屏', exact: true }).click()
      await page.waitForFunction(() => document.fullscreenElement !== null)
      await reveal(page)
    })
  } finally {
    await application.close()
    active.delete(application)
  }
}

async function captureAdmin() {
  const { application, page } = await launch({ name: 'admin', width: 1440, height: 900 })
  try {
    await step(page, 'admin-01-editor', async () => {
      await page.goto('app://app/admin')
      await page.locator('.editor').waitFor()
    })
    await step(page, 'admin-02-screenshot-sample', async () => {
      const frame = join(root, 'public', 'test-sources', 'frame-0-20.png')
      await page.locator('main input[accept^="image/"]').setInputFiles(frame)
      await page.locator('img.editor-media').waitFor()
    })
  } finally {
    await application.close()
    active.delete(application)
  }
}

async function main() {
  await mkdir(outDir, { recursive: true })
  await mkdir(runtime, { recursive: true })
  try {
    for (const viewport of VIEWPORTS) {
      try { await captureViewport(viewport) }
      catch (error) { results.push({ name: viewport.name, status: 'failed', message: String(error).split('\n')[0] }) }
    }
    try { await captureAdmin() }
    catch (error) { results.push({ name: 'admin', status: 'failed', message: String(error).split('\n')[0] }) }
  } finally {
    const closed = await Promise.allSettled([...active].map(application => application.close()))
    if (closed.some(result => result.status === 'rejected')) {
      results.push({ name: 'cleanup', status: 'failed', message: '截图测试应用未能关闭, 临时 Profile 已保留' })
    } else {
      if (dirname(runtime) !== runtimeRoot || !/^runtime-[a-f0-9-]{36}$/.test(basename(runtime))) {
        throw new Error('Invalid screenshot profile cleanup path')
      }
      try { await rm(runtime, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) }
      catch { results.push({ name: 'cleanup', status: 'failed', message: '临时截图 Profile 清理失败, 请检查本轮目录' }) }
    }
    const failures = results.filter(item => item.status === 'failed').length + pageErrors.length
    await writeFile(join(outDir, 'capture-report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), screenshots, failures, offline: true, viewports: VIEWPORTS, results, pageErrors,
    }, null, 2) + '\n')
    console.log('\n' + screenshots + ' 张截图, ' + failures + ' 项失败. 报告: ' + join(outDir, 'capture-report.json'))
    if (failures) process.exitCode = 1
  }
}
await main()
