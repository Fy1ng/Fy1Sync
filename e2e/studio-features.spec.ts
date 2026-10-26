import type { ElectronApplication, Page } from '@playwright/test'
import type { ChatMessage } from '../server/danmaku/douyuProtocol'
import { expect, test } from './electron'
import {
  connectDanmaku, fixturesReady, FIXTURES, invoke, loadBothFixtures, mediaTimes,
  openDanmakuSettings, openDouyuDesk, openPlayer, openSettings, revealOverlay, setCheckedByLabel, setPlaying,
} from './helpers'

test.skip(!fixturesReady(), '需要先运行 npm run fixtures')

async function openPipMenu(page: Page) {
  await revealOverlay(page)
  await page.locator('.dock').getByRole('button', { name: '画中画', exact: true }).click()
  return page.getByRole('dialog', { name: '画中画', exact: true })
}

async function prepareChat(page: Page, application: ElectronApplication): Promise<void> {
  await application.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { setDouyuToolsFixture(): void } }
    main.__streamSyncerTest.setDouyuToolsFixture()
  })
  await openPlayer(page)
  expect(await invoke(page, 'loginDouyuAccount', { id: 'default' })).toMatchObject({ ok: true })
  await loadBothFixtures(page)
  await setPlaying(page, false)
  await connectDanmaku(page)
  await application.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): void } }
    main.__streamSyncerTest.emitDanmaku('288016', 'state', { room: '288016', state: 'connected' })
  })
  const expand = page.getByRole('button', { name: '展开弹幕', exact: true })
  if (await expand.isVisible()) await expand.click()
  await expect(page.getByRole('textbox', { name: '弹幕内容', exact: true })).toBeEnabled()
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus() })
}

async function emitMessage(application: ElectronApplication, text: string, username = '离线观众'): Promise<void> {
  await application.evaluate((_electron, { content, username }) => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): void } }
    main.__streamSyncerTest.emitDanmaku('288016', 'danmaku', {
      id: 'studio-' + Date.now(), text: content, username, sender: { uid: '42', level: 8 },
      color: 0, level: 8, receivedAt: Date.now(), room: '288016', system: false,
    } satisfies ChatMessage)
  }, { content: text, username })
}

test('同屏小窗独立播放, 拖动缩放和快退不改变双路对齐', async ({ page }, testInfo) => {
  await openPlayer(page)
  await loadBothFixtures(page)
  await setPlaying(page, false)
  const before = await mediaTimes(page)
  await revealOverlay(page)
  await page.getByRole('button', { name: '同屏观看其他直播间', exact: true }).click()
  const form = page.getByRole('dialog', { name: '同屏观看', exact: true })
  await form.getByRole('textbox', { name: '直播间房间号或链接' }).fill(FIXTURES.commentary)
  await form.getByRole('button', { name: '打开', exact: true }).click()
  const floating = page.locator('.xs-window')
  await expect(floating).toHaveCount(1)
  const video = floating.locator('video')
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && !node.paused)).toBe(true)
  const id = await floating.getAttribute('data-stream-id')
  expect(id).toMatch(/^stream-[a-f0-9]{32}$/)
  expect(await invoke(page, 'getStreamSessions', undefined)).toMatchObject({ ok: true, value: { sessions: [{ id, phase: 'ready' }] } })

  await video.evaluate((node: HTMLVideoElement) => { node.pause(); node.currentTime = 12 })
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(12, 1)
  await floating.focus()
  await floating.press('ArrowLeft')
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(7, 1)
  expect(await mediaTimes(page)).toEqual(before)

  const initial = await floating.boundingBox()
  const head = await floating.locator('.xs-head').boundingBox()
  if (!initial || !head) throw new Error('小窗位置不可用')
  await page.mouse.move(head.x + 80, head.y + 12)
  await page.mouse.down()
  await page.mouse.move(head.x + 10, head.y + 52, { steps: 8 })
  await page.mouse.up()
  const moved = await floating.boundingBox()
  expect(moved!.x).toBeLessThan(initial.x - 40)
  expect(moved!.y).toBeGreaterThan(initial.y + 20)
  const grip = await floating.locator('.xs-resize').boundingBox()
  if (!grip) throw new Error('小窗缩放控件不可用')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + 70, grip.y + 50, { steps: 8 })
  await page.mouse.up()
  expect((await floating.boundingBox())!.width).toBeGreaterThan(moved!.width + 20)
  await floating.getByRole('button', { name: '取消静音', exact: true }).click()
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.muted)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('extra-stream.png') })
  await floating.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(floating).toHaveCount(0)
  expect(await invoke(page, 'getStreamSessions', undefined)).toMatchObject({ ok: true, value: { sessions: [] } })
  expect(await mediaTimes(page)).toEqual(before)
})

test('系统画中画由真实点击打开并可关闭', async ({ page }) => {
  await openPlayer(page)
  await loadBothFixtures(page)
  const menu = await openPipMenu(page)
  await menu.getByRole('button', { name: /^系统画中画/ }).click()
  await expect.poll(() => page.evaluate(() => (document.pictureInPictureElement as HTMLVideoElement | null)?.dataset.role)).toBe('official')
  await expect(page.locator('.pip-control > button')).toHaveClass(/is-on/)
  await expect(menu).toBeHidden()
  // Popover triggers intentionally ignore clicks within 120 ms of dismissal.
  await page.waitForTimeout(150)
  const reopened = await openPipMenu(page)
  await reopened.getByRole('button', { name: /^关闭系统画中画/ }).click()
  await expect.poll(() => page.evaluate(() => document.pictureInPictureElement === null)).toBe(true)
})

test('增强画中画页面自行就绪, 切换音频归属并恢复视频', async ({ page, electronApp }, testInfo) => {
  await openPlayer(page)
  await loadBothFixtures(page)
  // Local fixture URLs load directly in the renderer; register the matching acquisition
  // source so the real restricted PiP window can request its own playback descriptor.
  expect(await invoke(page, 'resolve', { input: FIXTURES.official, role: 'official' })).toMatchObject({ ok: true, value: { ok: true } })
  expect(await invoke(page, 'setEnhancedPipOptions', { lowPower: true })).toMatchObject({ ok: true })
  const menu = await openPipMenu(page)
  const opened = electronApp.waitForEvent('window')
  await menu.getByRole('button', { name: /^增强画中画/ }).click()
  const pip = await opened
  const errors: string[] = []
  pip.on('pageerror', error => errors.push(error.message))
  await pip.waitForURL('app://app/pip')
  await expect(pip.locator('.pip-page')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 })
  const video = pip.locator('video')
  await expect(video).toHaveCount(1)
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && node.currentTime > 0 && !node.paused)).toBe(true)
  expect(await invoke(page, 'getEnhancedPip', undefined)).toMatchObject({ ok: true, value: { phase: 'ready', audioOwner: 'pip' } })
  const ownership = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
    path: new URL(win.webContents.getURL()).pathname, visible: win.isVisible(),
    muted: win.webContents.isAudioMuted(), throttle: win.webContents.backgroundThrottling,
  })))
  expect(ownership.find(win => win.path === '/')).toMatchObject({ muted: true, throttle: true })
  expect(ownership.find(win => win.path === '/pip')).toMatchObject({ visible: true, muted: false })
  expect(await invoke(pip, 'getDouyuTasks', undefined)).toMatchObject({ ok: false, code: 'forbidden' })
  await expect(pip.getByRole('textbox', { name: '发送弹幕', exact: true })).toBeDisabled()
  const handle = await video.elementHandle()
  const previous = await invoke(page, 'getEnhancedPip', undefined)
  await pip.getByRole('button', { name: '恢复画面', exact: true }).click()
  await expect.poll(async () => {
    const state = await invoke(page, 'getEnhancedPip', undefined)
    return state.ok && state.value.recoveryRevision
  }).toBe(previous.ok ? previous.value.recoveryRevision + 1 : -1)
  expect(await handle!.evaluate(node => node === document.querySelector('video'))).toBe(true)
  await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && !node.paused)).toBe(true)
  await pip.screenshot({ path: testInfo.outputPath('enhanced-pip.png') })
  expect(errors).toEqual([])
  await pip.getByRole('button', { name: '关闭画中画', exact: true }).click()
  await expect.poll(() => pip.isClosed()).toBe(true)
  expect(await invoke(page, 'getEnhancedPip', undefined)).toMatchObject({ ok: true, value: { phase: 'closed', audioOwner: 'main' } })
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isAudioMuted())).toBe(false)
})

test('截图与 GIF 仅在启用后出现, 取消后清理录制且不保存', async ({ page, electronApp }, testInfo) => {
  await openPlayer(page)
  await loadBothFixtures(page)
  await expect(page.getByRole('button', { name: '截图', exact: true })).toHaveCount(0)
  await electronApp.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __studioSaveDialogs?: number }
    state.__studioSaveDialogs = 0
    dialog.showSaveDialog = async () => { state.__studioSaveDialogs!++; return { canceled: true, filePath: '' } }
  })
  const settings = await openSettings(page)
  await setCheckedByLabel(settings.getByRole('switch', { name: '启用截图与 GIF', exact: true }))
  await expect(settings.getByRole('switch', { name: '启用截图与 GIF', exact: true })).toBeEnabled()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await revealOverlay(page)
  await page.getByRole('button', { name: '截图', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已取消保存' })).toBeVisible()
  // Saving the screenshot can outlast the dock's idle timer.
  await revealOverlay(page)
  await page.getByRole('button', { name: 'GIF 录制', exact: true }).click()
  const gif = page.getByRole('dialog', { name: 'GIF 录制', exact: true })
  await gif.getByRole('spinbutton', { name: '帧率', exact: true }).fill('2')
  await gif.getByRole('spinbutton', { name: '时长', exact: true }).fill('10')
  await gif.getByRole('spinbutton', { name: '宽度', exact: true }).fill('160')
  await gif.getByRole('button', { name: '开始录制', exact: true }).click()
  await expect.poll(async () => {
    const state = await invoke(page, 'getCaptureState', undefined)
    return state.ok ? state.value.recordings[0]?.frames ?? 0 : 0
  }).toBeGreaterThan(0)
  // Keep the pointer idle beyond the dock's 3.2-second auto-hide delay.
  await page.waitForTimeout(3500)
  await expect(page.locator('.dock')).toHaveCSS('opacity', '1')
  await gif.getByRole('button', { name: '取消', exact: true }).click()
  await expect(gif.getByRole('status')).toHaveText('录制已取消')
  await expect.poll(async () => {
    const state = await invoke(page, 'getCaptureState', undefined)
    return state.ok && state.value.recordings.length
  }).toBe(0)
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __studioSaveDialogs?: number }).__studioSaveDialogs)).toBe(1)
  await gif.getByRole('button', { name: '开始录制', exact: true }).click()
  await expect(gif.getByRole('button', { name: '停止并保存', exact: true })).toBeEnabled()
  await gif.getByRole('button', { name: '停止并保存', exact: true }).click()
  await expect(gif.getByRole('status')).toHaveText('已取消保存', { timeout: 30_000 })
  expect(await invoke(page, 'getCaptureState', undefined)).toMatchObject({ ok: true, value: { recordings: [] } })
  expect(await electronApp.evaluate(() => (globalThis as typeof globalThis & { __studioSaveDialogs?: number }).__studioSaveDialogs)).toBe(2)
  await page.screenshot({ path: testInfo.outputPath('capture-cancelled.png') })
})

test('画面和列表弹幕菜单共用收藏, 回复仅填草稿', async ({ page, electronApp }, testInfo) => {
  await prepareChat(page, electronApp)
  const settings = await openDanmakuSettings(page)
  await setCheckedByLabel(settings.getByRole('switch', { name: /^用户详情/ }))
  await settings.getByRole('button', { name: '关闭弹幕设置', exact: true }).click()
  await emitMessage(electronApp, '离线菜单验收')
  const row = page.getByRole('log', { name: '弹幕列表' }).locator('.msg').filter({ hasText: '离线菜单验收' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: /^更多操作/ }).click()
  const menu = page.getByRole('dialog', { name: /^弹幕操作/ })
  await menu.getByRole('button', { name: '收藏', exact: true }).click()
  await expect(menu.getByRole('status')).toHaveText('已收藏')
  expect(await invoke(page, 'queryDanmakuFavorites', { query: '离线菜单验收' })).toMatchObject({ ok: true, value: { total: 1 } })
  await menu.getByRole('button', { name: '用户详情', exact: true }).click()
  const details = page.getByRole('dialog', { name: '用户详情', exact: true })
  await expect(details).toContainText('42')
  await details.getByRole('button', { name: '关闭', exact: true }).click()
  await row.getByRole('button', { name: /^更多操作/ }).click()
  await page.getByRole('dialog', { name: /^弹幕操作/ }).getByRole('button', { name: '回复', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '弹幕内容', exact: true })).toHaveValue(/^@离线观众/)
  const sent = await electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { getDouyuSentFixture(): unknown[] } }
    return main.__streamSyncerTest.getDouyuSentFixture()
  })
  expect(sent).toEqual([])
  await emitMessage(electronApp, '离线画面悬停验收')
  const item = page.locator('.danmaku-item').filter({ hasText: '离线画面悬停验收' })
  await expect(item).toBeVisible()
  // Moving text never satisfies Playwright's stable-element hover precondition.
  // Move the real pointer into its current visible bounds instead.
  await expect.poll(async () => (await item.boundingBox())!.x).toBeLessThan(600)
  const itemBox = await item.boundingBox()
  if (!itemBox) throw new Error('画面弹幕位置不可用')
  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2)
  const toolbar = page.getByRole('toolbar', { name: /^弹幕操作/ })
  await expect(toolbar.getByRole('button', { name: '收藏', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '收藏', exact: true }).click()
  expect(await invoke(page, 'queryDanmakuFavorites', { query: '离线画面悬停验收' })).toMatchObject({ ok: true, value: { total: 1 } })
  await page.screenshot({ path: testInfo.outputPath('danmaku-menu.png') })

  await electronApp.evaluate(() => {
    const main = globalThis as typeof globalThis & { __streamSyncerTest: { emitDanmaku(room: string, event: string, data: unknown): void } }
    for (let i = 0; i < 40; i++) main.__streamSyncerTest.emitDanmaku('288016', 'danmaku', {
      id: 'menu-fill-' + i, text: '菜单定位填充 ' + i, username: '填充观众',
      color: 0, level: 0, receivedAt: Date.now(), room: '288016', system: false,
    } satisfies ChatMessage)
  })
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(size)
    const text = `底部菜单验收 ${size.width}`
    const username = `底部观众 ${size.width}`
    await emitMessage(electronApp, text, username)
    const bottomRow = page.getByRole('log', { name: '弹幕列表' }).locator('.msg').filter({ hasText: text })
    await expect(bottomRow).toBeInViewport()
    await bottomRow.getByRole('button', { name: /^更多操作/ }).click()
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height)
    await page.screenshot({ path: testInfo.outputPath(`bottom-menu-${size.width}.png`) })
    await menu.getByRole('button', { name: '屏蔽此用户', exact: true }).click()
    await expect(menu).toBeHidden()
    await emitMessage(electronApp, '屏蔽后不再显示 ' + size.width, username)
    await emitMessage(electronApp, '屏蔽后仍收到其他用户 ' + size.width)
    await expect(page.getByRole('log', { name: '弹幕列表' })).toContainText('屏蔽后仍收到其他用户 ' + size.width)
    await expect(page.getByRole('log', { name: '弹幕列表' })).not.toContainText('屏蔽后不再显示 ' + size.width)
  }
})

interface StudioHttpFixture {
  permission: boolean
  stock: number
  unknownGift: boolean
  writes: Array<{ path: string; fields: Record<string, string> }>
}

/** Replace only network I/O in this disposable offline process; keep IPC and gateways real. */
async function installHttpFixture(application: ElectronApplication): Promise<void> {
  await application.evaluate(() => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('HTTP fixture is offline-only')
    const main = globalThis as typeof globalThis & { __studioHttpFixture: StudioHttpFixture }
    const fixture: StudioHttpFixture = { permission: true, stock: 4, unknownGift: false, writes: [] }
    main.__studioHttpFixture = fixture
    const dns = process.getBuiltinModule('node:dns/promises')!
    // The production DNS/host/IP checks still run against a fixed public address.
    dns.lookup = (async (host: string, options?: number | { all?: boolean }) => {
      if (!['www.douyu.com', 'gift.douyucdn.cn'].includes(host)) throw new Error('Unexpected fixture DNS target')
      const address = { address: '8.8.8.8', family: 4 }
      return typeof options === 'object' && options.all ? [address] : address
    }) as typeof dns.lookup
    const original = globalThis.fetch
    const item = () => ({ id: 90001, count: fixture.stock, name: '离线验收道具', propType: 1,
      isClick: 1, isValuable: 1, met: -1, intimate: 60, price: 600, batchInfo: { '6': { batchNum: 6 } } })
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://www.douyu.com') {
        if (url.pathname === '/japi/firepower/apinc/roomAdmin/getStatus') {
          return Response.json({ error: 0, data: { has: fixture.permission ? 1 : 0 } })
        }
        if (url.pathname === '/japi/prop/backpack/web/v5') {
          return Response.json({ error: 0, data: { list: fixture.stock ? [item()] : [] } })
        }
        if (init?.method === 'POST' && ['/room/roomSetting/addMuteUser', '/japi/prop/donate/mainsite/v5'].includes(url.pathname)) {
          if (fixture.writes.length >= 8) throw new Error('Fixture write limit exceeded')
          const fields = Object.fromEntries(new URLSearchParams(String(init.body)))
          fixture.writes.push({ path: url.pathname, fields })
          if (url.pathname === '/room/roomSetting/addMuteUser') return Response.json({ error: 0, msg: '添加成功' })
          const quantity = Number(fields.propCount)
          if (fields.roomId !== '288016' || fields.propId !== '90001' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > fixture.stock) {
            throw new Error('Invalid inventory fixture write')
          }
          fixture.stock -= quantity
          return fixture.unknownGift ? Response.json({ error: 0 })
            : Response.json({ error: 0, data: { usedProp: { id: 90001, propType: 1 }, list: [item()], messages: [] } })
        }
      }
      // The launcher's offline fetch rejects every unrelated HTTP request.
      return original(input, init)
    }
  })
}

async function httpState(application: ElectronApplication): Promise<StudioHttpFixture> {
  return application.evaluate(() => (globalThis as typeof globalThis & { __studioHttpFixture: StudioHttpFixture }).__studioHttpFixture)
}

test('禁言先检查权限, 明确确认后仅向固定房间提交一次', async ({ page, electronApp }, testInfo) => {
  await installHttpFixture(electronApp)
  await prepareChat(page, electronApp)
  await emitMessage(electronApp, '离线禁言验收')
  const row = page.getByRole('log', { name: '弹幕列表' }).locator('.msg').filter({ hasText: '离线禁言验收' })
  await row.getByRole('button', { name: /^更多操作/ }).click()
  await page.getByRole('dialog', { name: /^弹幕操作/ }).getByRole('button', { name: '禁言', exact: true }).click()
  const mute = page.getByRole('dialog', { name: '禁言', exact: true })
  await expect(mute.getByRole('button', { name: /^确认禁言/ })).toBeEnabled()
  await expect(mute).toContainText('288016')
  await expect(mute).toContainText('离线观众')
  expect((await httpState(electronApp)).writes).toEqual([])
  await mute.getByRole('combobox', { name: '禁言时长', exact: true }).selectOption('60')
  await mute.getByRole('button', { name: '确认禁言 1 小时', exact: true }).click()
  await expect(mute.getByRole('status')).toContainText('禁言成功回执')
  await expect(mute.getByRole('button', { name: /^确认禁言/ })).toHaveCount(0)
  expect((await httpState(electronApp)).writes).toEqual([{ path: '/room/roomSetting/addMuteUser',
    fields: { ban_nickname: '离线观众', room_id: '288016', ban_time: '60', reason: '7' } }])
  await page.screenshot({ path: testInfo.outputPath('mute-confirmed.png') })
  await mute.getByRole('button', { name: '关闭', exact: true }).click()
  await electronApp.evaluate(() => { (globalThis as typeof globalThis & { __studioHttpFixture: StudioHttpFixture }).__studioHttpFixture.permission = false })
  await row.getByRole('button', { name: /^更多操作/ }).click()
  await page.getByRole('dialog', { name: /^弹幕操作/ }).getByRole('button', { name: '禁言', exact: true }).click()
  await expect(mute.getByRole('alert')).toContainText('未授予')
  await expect(mute.getByRole('button', { name: /^确认禁言/ })).toHaveCount(0)
  expect((await httpState(electronApp)).writes).toHaveLength(1)
})

test('赠礼编辑作废预览, 确认按有效 planId 执行且未知结果不重试', async ({ page, electronApp }, testInfo) => {
  await installHttpFixture(electronApp)
  await prepareChat(page, electronApp)
  await page.evaluate(() => {
    const diagnostic = window as typeof window & { __giftRuntime?: unknown[] }
    diagnostic.__giftRuntime = []
    window.streamSyncer!.subscribeDouyuTasks!(snapshot => {
      diagnostic.__giftRuntime!.push({ at: Date.now(), room: snapshot.currentRoom, runtime: snapshot.runtime })
      if (diagnostic.__giftRuntime!.length > 100) diagnostic.__giftRuntime!.shift()
    })
  })
  await page.setViewportSize({ width: 1024, height: 700 })
  const desk = await openDouyuDesk(page)
  await desk.getByRole('tab', { name: '背包', exact: true }).click()
  const quantity = desk.getByRole('textbox', { name: '离线验收道具 赠送数量', exact: true })
  await expect(quantity).toBeVisible()
  await quantity.fill('1')
  await desk.getByRole('textbox', { name: /赠送间隔/ }).fill('0')
  await desk.getByRole('button', { name: '生成预览', exact: true }).click()
  const plan = desk.getByRole('region', { name: '赠送确认单', exact: true })
  const confirmGift = async () => {
    // The real queue cancels account writes when its window loses foreground ownership.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
    await expect.poll(() => invoke(page, 'getDouyuTasks', undefined)).toMatchObject({
      ok: true, value: { currentRoom: '288016', runtime: { foreground: true, locked: false, suspended: false } },
    })
    await plan.getByRole('button', { name: '确认赠送', exact: true }).click()
  }
  await expect(plan).toBeVisible()
  expect((await httpState(electronApp)).writes).toEqual([])
  await quantity.fill('2')
  await expect(plan).toHaveCount(0)
  await desk.getByRole('button', { name: '生成预览', exact: true }).click()
  await expect(plan).toBeVisible()
  await confirmGift()
  const result = desk.getByRole('region', { name: '赠送结果', exact: true })
  await expect(result).toContainText('已收到回执 2')
  await expect(plan.getByRole('button', { name: '确认赠送', exact: true })).toBeDisabled()
  expect((await httpState(electronApp)).writes).toEqual([{ path: '/japi/prop/donate/mainsite/v5',
    fields: { propId: '90001', propCount: '2', roomId: '288016', bizExt: '{"yzxq":{}}' } }])
  await desk.getByRole('button', { name: '刷新库存', exact: true }).click()
  await expect(desk.getByRole('button', { name: '刷新库存', exact: true })).toBeEnabled()
  await electronApp.evaluate(() => { (globalThis as typeof globalThis & { __studioHttpFixture: StudioHttpFixture }).__studioHttpFixture.unknownGift = true })
  await quantity.fill('1')
  await desk.getByRole('button', { name: '生成预览', exact: true }).click()
  await confirmGift()
  await expect(result).toContainText('结果未知')
  await expect(plan.getByRole('button', { name: '确认赠送', exact: true })).toBeDisabled()
  await page.waitForTimeout(1200)
  await testInfo.attach('gift-runtime.json', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() =>
    (window as typeof window & { __giftRuntime?: unknown[] }).__giftRuntime)) })
  await expect(result).toContainText('部分结果需要核对')
  expect((await httpState(electronApp)).writes).toHaveLength(2)
  await result.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('gift-unknown.png') })
})
