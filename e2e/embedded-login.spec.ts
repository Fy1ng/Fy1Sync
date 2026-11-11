import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { View, WebPreferences } from 'electron'
import { expect, launchApplication, visibleE2eWindows } from './electron'
import { invoke, openDouyuTab, openPlayer, openSettings } from './helpers'
import { captureEmbeddedWindow } from './captureEmbeddedWindow'

type Platform = 'douyu' | 'bilibili' | 'huya'
const NAME: Record<Platform, string> = { douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙' }
type PngImage = { width: number; height: number; data: Buffer }
// Reuse Playwright's bundled PNG codec; no additional dependency is installed.
const require = createRequire(import.meta.url)
const PNG = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js')).PNG as {
  sync: { read(input: Buffer): PngImage; write(image: PngImage): Buffer }
}

interface LoginFixture {
  setEmbeddedLoginFixture(): void | Promise<void>
  completeEmbeddedLoginFixture(platform: Platform, authenticated?: boolean): Promise<void>
  getEmbeddedLoginFixtureState(): { platform: string | null; active: boolean; requests: number }
}
type FixtureGlobal = typeof globalThis & { __streamSyncerTest?: LoginFixture }
type Rectangle = { x: number; y: number; width: number; height: number }
interface LayoutSnapshot {
  page: string | null
  width: number
  left: (Rectangle & { visible: boolean }) | null
  right: (Rectangle & { visible: boolean }) | null
}
interface NativeSnapshot {
  windowCount: number
  content: { width: number; height: number }
  views: Array<{
    id: number
    local: boolean
    separateFromPeer: boolean
    visible: boolean
    bounds: Rectangle
    isolatedSession: boolean
    preferences: { nodeIntegration: boolean; nodeIntegrationInSubFrames: boolean; nodeIntegrationInWorker: boolean
      sandbox: boolean; contextIsolation: boolean; webSecurity: boolean; preload: boolean }
  }>
}

/** This hook is installed only in the disposable offline app, and serves no network data. */
async function enableFixture(application: ElectronApplication): Promise<void> {
  await application.evaluate(async () => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1' || process.env.STREAM_SYNC_E2E !== '1') {
      throw new Error('Embedded login fixture requires an offline disposable E2E profile')
    }
    const fixture = (globalThis as FixtureGlobal).__streamSyncerTest
    if (!fixture?.setEmbeddedLoginFixture) throw new Error('Embedded login fixture hook is unavailable')
    await fixture.setEmbeddedLoginFixture()
  })
}

async function fixtureState(application: ElectronApplication): Promise<ReturnType<LoginFixture['getEmbeddedLoginFixtureState']>> {
  return application.evaluate(() => (globalThis as FixtureGlobal).__streamSyncerTest!.getEmbeddedLoginFixtureState())
}

async function completeFixture(application: ElectronApplication, platform: Platform, authenticated = true): Promise<void> {
  await application.evaluate(async (_electron, input) => {
    await (globalThis as FixtureGlobal).__streamSyncerTest!.completeEmbeddedLoginFixture(input.platform, input.authenticated)
  }, { platform, authenticated })
}

/** Read geometry and security settings, never cookies, input values or account data. */
async function nativeSnapshot(application: ElectronApplication): Promise<NativeSnapshot> {
  return application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
    const main = windows[0]
    if (!main) throw new Error('Main application window is missing')
    const content = main.getContentBounds()
    const descendants = (root: View): View[] => root.children.flatMap(child => [child, ...descendants(child)])
    const allViews = descendants(main.contentView)
    return {
      windowCount: windows.length,
      content: { width: content.width, height: content.height },
      views: await Promise.all(allViews.filter(view => view instanceof WebContentsView
        && view.webContents.id !== main.webContents.id).map(async view => {
        const native = view as InstanceType<typeof WebContentsView>
        const contents = native.webContents as typeof native.webContents & { getLastWebPreferences(): WebPreferences }
        const preferences = contents.getLastWebPreferences()
        // Electron 44 omits preload paths from getLastWebPreferences; inspect exposed capabilities.
        const capabilities = await contents.executeJavaScript('({localBridge:typeof window.loginCard === "object",appBridge:typeof window.streamSyncer !== "undefined"})') as { localBridge: boolean; appBridge: boolean }
        if (capabilities.appBridge) throw new Error('A login view exposes the main application bridge')
        return { id: native.webContents.id, visible: native.getVisible(), bounds: native.getBounds(),
          local: native.webContents.getURL().startsWith('app://login/'),
          separateFromPeer: allViews.filter(child => child instanceof WebContentsView
            && child.webContents.id !== main.webContents.id && child.webContents.id !== native.webContents.id)
            .every(child => (child as InstanceType<typeof WebContentsView>).webContents.session !== native.webContents.session),
          isolatedSession: native.webContents.session !== main.webContents.session,
          preferences: { nodeIntegration: preferences.nodeIntegration === true,
            nodeIntegrationInSubFrames: preferences.nodeIntegrationInSubFrames === true,
            nodeIntegrationInWorker: preferences.nodeIntegrationInWorker === true,
            sandbox: preferences.sandbox === true, contextIsolation: preferences.contextIsolation === true,
            webSecurity: preferences.webSecurity !== false, preload: capabilities.localBridge } }
      })),
    }
  })
}

function overlay(page: Page, platform: Platform): Locator {
  return page.getByRole('dialog', { name: `${NAME[platform]}登录`, exact: true })
}

async function assertNativeCard(application: ElectronApplication, page: Page, platform: Platform): Promise<NativeSnapshot> {
  const card = overlay(page, platform)
  await expect(card).toBeVisible()
  await expect.poll(async () => {
    const state = await invoke(page, 'getEmbeddedLogin', undefined)
    return state.ok && state.value?.platform === platform && ['ready', 'verifying'].includes(state.value.phase)
  }).toBe(true)
  await expect.poll(async () => {
    const state = await nativeSnapshot(application)
    return state.views.length === 2 && state.views.some(view => view.local && view.visible && view.bounds.width > 0)
  }).toBe(true)
  const snapshot = await nativeSnapshot(application)
  expect(snapshot.windowCount).toBe(1)
  const view = snapshot.views.find(view => view.local)!
  const remote = snapshot.views.find(view => !view.local)!
  expect(remote.visible).toBe(false)
  for (const current of snapshot.views) {
    expect(current.isolatedSession).toBe(true)
    expect(current.separateFromPeer).toBe(true)
    expect(current.preferences).toEqual({ nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, sandbox: true, contextIsolation: true, webSecurity: true, preload: current.local })
  }
  const host = await card.getByTestId('embedded-login-host').boundingBox()
  if (!host) throw new Error('Login card host has no visible rectangle')
  for (const field of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(view.bounds[field] - host[field])).toBeLessThanOrEqual(2)
  expect(view.bounds.x).toBeGreaterThanOrEqual(0)
  expect(view.bounds.y).toBeGreaterThanOrEqual(0)
  expect(view.bounds.x + view.bounds.width).toBeLessThanOrEqual(snapshot.content.width)
  expect(view.bounds.y + view.bounds.height).toBeLessThanOrEqual(snapshot.content.height)
  const close = await card.getByRole('button', { name: `关闭${NAME[platform]}登录`, exact: true }).boundingBox()
  if (!close) throw new Error('Login card close button is not visible')
  expect(close.y + close.height).toBeLessThanOrEqual(view.bounds.y)
  expect(await fixtureState(application)).toMatchObject({ platform, active: true })
  expect((await fixtureState(application)).requests).toBeGreaterThan(0)
  return snapshot
}

/** Read the visible unified card, without input values or the hidden official DOM. */
async function nativeLayout(application: ElectronApplication, platform: Platform): Promise<LayoutSnapshot | null> {
  return application.evaluate(async ({ BrowserWindow, WebContentsView }, selected) => {
    const main = BrowserWindow.getAllWindows()[0]!
    const descendants = (root: View): View[] => root.children.flatMap(child => [child, ...descendants(child)])
    const view = descendants(main.contentView).find(child => child instanceof WebContentsView
      && child.webContents.getURL().startsWith('app://login/')) as InstanceType<typeof WebContentsView> | undefined
    if (!view) throw new Error('Native login view is missing')
    const selectors = ['[data-login-column="qr"]', '[data-login-column="form"]']
    const script = `(() => {
      const selectors = ${JSON.stringify(selectors)};
      const geometry = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          visible: getComputedStyle(node).display !== 'none' && rect.width > 0 && rect.height > 0 };
      };
      return { page: document.getElementById('card').dataset.platform,
        width: innerWidth, left: geometry(selectors[0]), right: geometry(selectors[1]) };
    })()`
    const frames = view.webContents.mainFrame.framesInSubtree
    const results = await Promise.all(frames.map(async frame => {
      try { return await frame.executeJavaScript(script) as LayoutSnapshot } catch { return null }
    }))
    return results.find(result => result?.page === selected && result.left && result.right) ?? null
  }, platform)
}

async function assertNativeLayout(application: ElectronApplication, platform: Platform): Promise<LayoutSnapshot> {
  type Layout = { width: number; left: Rectangle & { visible: boolean }; right: Rectangle & { visible: boolean } }
  await expect.poll(async () => {
    const layout = await nativeLayout(application, platform) as Layout | null
    return Boolean(layout?.left.visible && layout.right.visible)
  }).toBe(true)
  const layout = await nativeLayout(application, platform) as LayoutSnapshot & Layout
  expect(layout.page).toBe(platform)
  expect(layout.left.x).toBeGreaterThanOrEqual(0)
  expect(layout.left.x + layout.left.width).toBeLessThanOrEqual(layout.right.x)
  expect(layout.right.x + layout.right.width).toBeLessThanOrEqual(layout.width)
  expect(layout.left.width).toBeGreaterThan(150)
  expect(layout.right.width).toBeGreaterThan(200)
  return layout
}

async function assertReleased(application: ElectronApplication, page: Page, platform: Platform, ids: number[]): Promise<void> {
  await expect(overlay(page, platform)).toBeHidden()
  await expect.poll(async () => (await nativeSnapshot(application)).views.length).toBe(0)
  await expect.poll(() => application.evaluate(({ webContents }, released) => released.every(id => {
    const contents = webContents.fromId(id)
    return !contents || contents.isDestroyed()
  }), ids)).toBe(true)
  expect(await fixtureState(application)).toMatchObject({ active: false, platform: null })
  expect((await nativeSnapshot(application)).windowCount).toBe(1)
}

async function loginStatus(page: Page): Promise<Record<Platform, boolean>> {
  const status = await invoke(page, 'loginStatus', undefined)
  if (!status.ok) throw new Error('Platform login status is unavailable')
  return { douyu: status.value.douyu.loggedIn, bilibili: status.value.bilibili.loggedIn, huya: status.value.huya.loggedIn }
}

/** Compose separate Chromium surfaces at their measured bounds, retaining both originals. */
async function captureCard(application: ElectronApplication, testInfo: TestInfo, platform: Platform, label: string): Promise<void> {
  await mkdir(testInfo.outputDir, { recursive: true })
  const images = await captureEmbeddedWindow(application)
  const shell = Buffer.from(images.shell, 'base64')
  await writeFile(testInfo.outputPath(`${platform}-${label}-shell.png`), shell)
  if (!images.native || !images.bounds) throw new Error('Native login screenshot is missing')
  const native = Buffer.from(images.native, 'base64')
  await writeFile(testInfo.outputPath(`${platform}-${label}-native.png`), native)
  const composed = PNG.sync.read(shell)
  const child = PNG.sync.read(Buffer.from(images.scaled, 'base64'))
  const scaleX = composed.width / images.content.width
  const scaleY = composed.height / images.content.height
  const x = Math.round(images.bounds.x * scaleX)
  const y = Math.round(images.bounds.y * scaleY)
  expect(Math.abs(child.width - images.bounds.width * scaleX)).toBeLessThanOrEqual(2)
  expect(Math.abs(child.height - images.bounds.height * scaleY)).toBeLessThanOrEqual(2)
  expect(x + child.width).toBeLessThanOrEqual(composed.width)
  expect(y + child.height).toBeLessThanOrEqual(composed.height)
  for (let row = 0; row < child.height; row += 1) {
    child.data.copy(composed.data, ((y + row) * composed.width + x) * 4, row * child.width * 4, (row + 1) * child.width * 4)
  }
  await writeFile(testInfo.outputPath(`${platform}-${label}-card.png`), PNG.sync.write(composed))
}

test('B站和虎牙内嵌登录支持取消, 持久登录和平台隔离', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const running = await launchApplication('embedded-login')
  const evidence: unknown[] = []
  try {
    await enableFixture(running.application)
    await openPlayer(running.page)
    expect(await loginStatus(running.page)).toEqual({ douyu: false, bilibili: false, huya: false })
    for (const platform of ['bilibili', 'huya'] as const) {
      const settings = await openSettings(running.page, NAME[platform])
      const account = settings.getByRole('region', { name: `${NAME[platform]}账号`, exact: true })
      await expect(account.getByText('未登录', { exact: true })).toBeVisible()
      await account.getByRole('button', { name: '登录', exact: true }).click()
      let native = await assertNativeCard(running.application, running.page, platform)
      evidence.push({ platform, action: 'first-login', native, layout: await assertNativeLayout(running.application, platform) })
      await captureCard(running.application, testInfo, platform, 'desktop')
      if (platform === 'bilibili') {
        await running.application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setContentSize(900, 650) })
        await expect.poll(() => running.page.evaluate(() => window.innerWidth)).toBe(900)
        native = await assertNativeCard(running.application, running.page, platform)
        evidence.push({ platform, action: 'resized-login', native })
        await captureCard(running.application, testInfo, platform, 'compact')
      }
      await overlay(running.page, platform).getByRole('button', { name: `关闭${NAME[platform]}登录`, exact: true }).click()
      await assertReleased(running.application, running.page, platform, native.views.map(view => view.id))
      await expect(account.getByText('未登录', { exact: true })).toBeVisible()
      expect((await loginStatus(running.page))[platform]).toBe(false)
      await account.getByRole('button', { name: '登录', exact: true }).click()
      native = await assertNativeCard(running.application, running.page, platform)
      await completeFixture(running.application, platform)
      await assertReleased(running.application, running.page, platform, native.views.map(view => view.id))
      await expect(account.getByText('已登录', { exact: true })).toBeVisible()
      expect((await loginStatus(running.page))[platform]).toBe(true)
    }

    const signedInSettings = await openSettings(running.page, '哔哩哔哩')
    const signedInAccount = signedInSettings.getByRole('region', { name: '哔哩哔哩账号', exact: true })
    await signedInAccount.getByRole('button', { name: '重新登录', exact: true }).click()
    const relogin = await assertNativeCard(running.application, running.page, 'bilibili')
    await overlay(running.page, 'bilibili').getByRole('button', { name: '关闭哔哩哔哩登录', exact: true }).click()
    await assertReleased(running.application, running.page, 'bilibili', relogin.views.map(view => view.id))
    await expect(signedInAccount.getByText('已登录', { exact: true })).toBeVisible()
    expect(await loginStatus(running.page)).toEqual({ douyu: false, bilibili: true, huya: true })

    await running.restart()
    await enableFixture(running.application)
    await openPlayer(running.page)
    expect(await loginStatus(running.page)).toEqual({ douyu: false, bilibili: true, huya: true })
    expect((await nativeSnapshot(running.application)).views).toEqual([])
    const restored = await openSettings(running.page, '哔哩哔哩')
    await expect(restored.getByRole('region', { name: '哔哩哔哩账号', exact: true }).getByText('已登录', { exact: true })).toBeVisible()
    await restored.getByRole('region', { name: '哔哩哔哩账号', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
    await expect.poll(() => loginStatus(running.page)).toEqual({ douyu: false, bilibili: false, huya: true })
    await openSettings(running.page, '虎牙')
    await expect(restored.getByRole('region', { name: '虎牙账号', exact: true }).getByText('已登录', { exact: true })).toBeVisible()
    await running.restart()
    await enableFixture(running.application)
    expect(await loginStatus(running.page)).toEqual({ douyu: false, bilibili: false, huya: true })
  } finally {
    try {
      await mkdir(testInfo.outputDir, { recursive: true })
      await writeFile(testInfo.outputPath('embedded-login-platforms.json'), JSON.stringify(evidence, null, 2))
    } finally { await running.close() }
  }
})

test('斗鱼账号入口在主窗口登录, 本地卡片 Escape 取消并在成功后保留账号', async ({}, testInfo) => {
  test.skip(!visibleE2eWindows, '原生登录卡片 Escape 输入需要窗口和 WebContents 的真实焦点; 设置 STREAM_SYNC_E2E_VISIBLE=1')
  test.setTimeout(120_000)
  const running = await launchApplication('embedded-login')
  const evidence: unknown[] = []
  try {
    await enableFixture(running.application)
    await openPlayer(running.page)
    const settings = await openDouyuTab(running.page, '账号')
    const account = settings.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
    await expect(account).toContainText('未登录')
    await account.getByRole('button', { name: '登录', exact: true }).click()
    let native = await assertNativeCard(running.application, running.page, 'douyu')
    evidence.push({ action: 'first-login', native, layout: await assertNativeLayout(running.application, 'douyu') })
    await captureCard(running.application, testInfo, 'douyu', 'desktop')
    await running.application.evaluate(({ BrowserWindow, webContents }, id) => {
      BrowserWindow.getAllWindows()[0]!.focus()
      const contents = webContents.fromId(id)
      if (!contents) throw new Error('Native login view is unavailable for Escape')
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    }, native.views.find(view => view.local)!.id)
    await assertReleased(running.application, running.page, 'douyu', native.views.map(view => view.id))
    await expect(settings).toBeVisible()
    await expect(account).toContainText('未登录')
    expect(await loginStatus(running.page)).toEqual({ douyu: false, bilibili: false, huya: false })
    await account.getByRole('button', { name: '登录', exact: true }).click()
    native = await assertNativeCard(running.application, running.page, 'douyu')
    await completeFixture(running.application, 'douyu')
    await assertReleased(running.application, running.page, 'douyu', native.views.map(view => view.id))
    await expect(account).toContainText('已登录')
    expect(await loginStatus(running.page)).toEqual({ douyu: true, bilibili: false, huya: false })
    await running.restart()
    await enableFixture(running.application)
    await openPlayer(running.page)
    const restored = await openDouyuTab(running.page, '账号')
    await expect(restored.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })).toContainText('已登录')
    expect(await loginStatus(running.page)).toEqual({ douyu: true, bilibili: false, huya: false })
    expect((await nativeSnapshot(running.application)).views).toEqual([])
  } finally {
    try {
      await mkdir(testInfo.outputDir, { recursive: true })
      await writeFile(testInfo.outputPath('embedded-login-douyu.json'), JSON.stringify(evidence, null, 2))
    } finally { await running.close() }
  }
})
