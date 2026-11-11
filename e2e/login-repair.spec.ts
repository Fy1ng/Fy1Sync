import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { Session, View } from 'electron'
import { expect, launchApplication, visibleE2eWindows } from './electron'
import { invoke, openDouyuTab, openPlayer, openSettings } from './helpers'
import { captureEmbeddedWindow } from './captureEmbeddedWindow'

type Platform = 'douyu' | 'bilibili' | 'huya'
type RepairScenario = 'password-error' | 'sms-captcha'
interface FixtureState {
  platform: string | null; active: boolean; requests: number; phase: string | null
  submitted: number; smsSent: number; verified: number; qrPolls: number
  pendingCaptcha: boolean; phoneChanges: number; navigationCount: number; mediaRequests: number
}
type FixtureGlobal = typeof globalThis & { __streamSyncerTest: {
  setEmbeddedLoginFixture(): void
  setEmbeddedLoginFixtureScenario(scenario: RepairScenario): void
  setEmbeddedLoginFixtureCooldown(seconds: number): void | Promise<void>
  getEmbeddedLoginFixtureState(): FixtureState
} }
type IdentityGlobal = typeof globalThis & { __loginRepairIdentity?: { local: Session; remote: Session; localId: number; remoteId: number } }
type PngImage = { width: number; height: number; data: Buffer }
const require = createRequire(import.meta.url)
const PNG = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js')).PNG as {
  sync: { read(bytes: Buffer): PngImage; write(image: PngImage): Buffer }
}
const NAME = { douyu: '斗鱼', bilibili: '哔哩哔哩', huya: '虎牙' } as const

async function fixture(application: ElectronApplication): Promise<FixtureState> {
  return application.evaluate(() => (globalThis as FixtureGlobal).__streamSyncerTest.getEmbeddedLoginFixtureState())
}
async function setScenario(application: ElectronApplication, selected: RepairScenario): Promise<void> {
  await application.evaluate((_electron, scenario) => {
    if (process.env.STREAM_SYNC_E2E !== '1' || process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Login repair requires a disposable offline profile')
    const hook = (globalThis as FixtureGlobal).__streamSyncerTest
    hook.setEmbeddedLoginFixture()
    hook.setEmbeddedLoginFixtureScenario(scenario)
  }, selected)
}
async function loggedIn(page: Page, platform: Platform): Promise<boolean> {
  const result = await invoke(page, 'loginStatus', undefined)
  if (!result.ok) throw new Error('Login status unavailable')
  return result.value[platform].loggedIn
}
async function accountPage(page: Page, platform: Platform): Promise<Locator> {
  const settings = platform === 'douyu' ? await openDouyuTab(page, '账号') : await openSettings(page, NAME[platform])
  return platform === 'douyu' ? settings.getByRole('group', { name: '斗鱼账号 默认账号', exact: true })
    : settings.getByRole('region', { name: `${NAME[platform]}账号`, exact: true })
}
async function localPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.context().pages().some(page => page.url().startsWith('app://login/'))).toBe(true)
  const page = application.context().pages().find(page => page.url().startsWith('app://login/'))!
  await expect(page.locator('#card')).toHaveAttribute('data-stage', 'form')
  return page
}

/** Recursive traversal accounts for the clipping View around the original captcha document. */
async function views(application: ElectronApplication, save = false): Promise<{
  localId: number; remoteId: number; remoteUrl: string; stable: boolean; localVisible: boolean; remoteVisible: boolean
}> {
  return application.evaluate(({ BrowserWindow, WebContentsView }, remember) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1) throw new Error('A login attempt created another OS window')
    const main = windows[0]!
    const descendants = (root: View, visible = true): Array<{ view: View; visible: boolean }> => root.children.flatMap(view => {
      const shown = visible && view.getVisible()
      return [{ view, visible: shown }, ...descendants(view, shown)]
    })
    const all = descendants(main.contentView).filter(item => item.view instanceof WebContentsView
      && item.view.webContents.id !== main.webContents.id)
    const local = all.find(item => (item.view as InstanceType<typeof WebContentsView>).webContents.getURL().startsWith('app://login/'))
    const remote = all.find(item => !(item.view as InstanceType<typeof WebContentsView>).webContents.getURL().startsWith('app://login/'))
    if (all.length !== 2 || !local || !remote) throw new Error('Login local/official views are missing')
    const localContents = (local.view as InstanceType<typeof WebContentsView>).webContents
    const remoteContents = (remote.view as InstanceType<typeof WebContentsView>).webContents
    const scope = globalThis as IdentityGlobal
    if (remember) scope.__loginRepairIdentity = { local: localContents.session, remote: remoteContents.session,
      localId: localContents.id, remoteId: remoteContents.id }
    const previous = scope.__loginRepairIdentity
    return { localId: localContents.id, remoteId: remoteContents.id, remoteUrl: remoteContents.getURL(),
      localVisible: local.visible, remoteVisible: remote.visible, stable: !!previous && previous.local === localContents.session
        && previous.remote === remoteContents.session && previous.localId === localContents.id && previous.remoteId === remoteContents.id }
  }, save)
}

async function mediaState(application: ElectronApplication, id: number): Promise<{ muted: boolean; count: number; paused: boolean }> {
  return application.evaluate(async ({ webContents }, remoteId) => {
    const contents = webContents.fromId(remoteId)
    if (!contents) throw new Error('Official fixture view is missing')
    const states = await Promise.all(contents.mainFrame.framesInSubtree.map(async frame => {
      try { return await frame.executeJavaScript(`Array.from(document.querySelectorAll('video,audio')).map(media => ({ paused: media.paused }))`) as Array<{ paused: boolean }> }
      catch { return [] }
    }))
    const media = states.flat()
    return { muted: contents.isAudioMuted(), count: media.length, paused: media.every(item => item.paused) }
  }, id)
}

async function completeCaptcha(application: ElectronApplication, id: number): Promise<void> {
  await application.evaluate(async ({ webContents }, remoteId) => {
    const contents = webContents.fromId(remoteId)
    if (!contents) throw new Error('Original captcha view is missing')
    for (const frame of contents.mainFrame.framesInSubtree) {
      const point = await frame.executeJavaScript(`(() => { const button = document.querySelector('button[data-fixture-captcha]'); if (!button) return null; const rect=button.getBoundingClientRect(); return { x:rect.x+rect.width/2,y:rect.y+rect.height/2 }; })()`).catch(() => null) as { x: number; y: number } | null
      if (!point) continue
      for (let child = frame; child.parent; child = child.parent) {
        const offset = await child.parent.executeJavaScript(`(() => {
          const frames=Array.from(document.querySelectorAll('iframe')).filter(element=>element.src===${JSON.stringify(child.url)}&&element.name===${JSON.stringify(child.name)});
          if(frames.length!==1)throw new Error('Ambiguous synthetic iframe');
          const element=frames[0],r=element.getBoundingClientRect();return {x:r.x+element.clientLeft,y:r.y+element.clientTop};
        })()`) as { x: number; y: number }
        point.x += offset.x; point.y += offset.y
      }
      const x = Math.round(point.x), y = Math.round(point.y)
      const target = new URL(frame.url)
      if (target.origin === 'https://t.captcha.qq.com' && target.pathname === '/cap_union_new_show') {
        // Electron sendInputEvent bypasses Chromium's OOPIF input router.
        // The existing root debugger dispatches trusted input through that router.
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
      } else {
        contents.sendInputEvent({ type: 'mouseMove', x, y })
        contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      }
      return
    }
    throw new Error('The original fixture captcha button is missing')
  }, id)
}

async function assertCaptchaClipping(application: ElectronApplication, page: Page, remoteId: number): Promise<unknown> {
  const slot = await page.getByTestId('embedded-login-host').boundingBox()
  if (!slot) throw new Error('Captcha slot has no bounds')
  const clipped = await application.evaluate(({ BrowserWindow, WebContentsView }, id) => {
    const main = BrowserWindow.getAllWindows()[0]!
    const parents = (root: View): Array<{ parent: View; child: View }> => root.children.flatMap(child => [
      { parent: root, child }, ...parents(child),
    ])
    const all = parents(main.contentView)
    const matches = all.filter(item => item.child instanceof WebContentsView && item.child.webContents.id === id)
    if (matches.length !== 1) throw new Error('Original captcha view is missing or duplicated')
    const target = matches[0]!
    return { nested: target.parent !== main.contentView, container: target.parent.getBounds(), remote: target.child.getBounds() }
  }, remoteId)
  expect(clipped.nested).toBe(true)
  expect(clipped.container.x).toBeGreaterThanOrEqual(Math.floor(slot.x))
  expect(clipped.container.y).toBeGreaterThanOrEqual(Math.floor(slot.y))
  expect(clipped.container.x + clipped.container.width).toBeLessThanOrEqual(Math.ceil(slot.x + slot.width))
  expect(clipped.container.y + clipped.container.height).toBeLessThanOrEqual(Math.ceil(slot.y + slot.height))
  expect(clipped.container.width).toBeGreaterThan(0)
  expect(clipped.container.height).toBeGreaterThan(0)
  expect(clipped.remote.width * clipped.remote.height).toBeGreaterThan(clipped.container.width * clipped.container.height)
  return clipped
}

/** Review pictures use only the local form after secrets have cleared; captcha remains original. */
async function capture(application: ElectronApplication, local: Page, testInfo: TestInfo, label: string): Promise<void> {
  expect(await local.locator('[data-secret]').evaluateAll(nodes => nodes.every(node => (node as HTMLInputElement).value === ''))).toBe(true)
  const images = await captureEmbeddedWindow(application, 'app://login/')
  const shell = PNG.sync.read(Buffer.from(images.shell, 'base64'))
  const child = PNG.sync.read(Buffer.from(images.scaled, 'base64'))
  const x = Math.round(images.bounds.x * shell.width / images.content.width)
  const y = Math.round(images.bounds.y * shell.height / images.content.height)
  expect(x + child.width).toBeLessThanOrEqual(shell.width)
  expect(y + child.height).toBeLessThanOrEqual(shell.height)
  for (let row = 0; row < child.height; row += 1) child.data.copy(shell.data,
    ((row + y) * shell.width + x) * 4, row * child.width * 4, (row + 1) * child.width * 4)
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(testInfo.outputPath(`${label}-card.png`), PNG.sync.write(shell))
  await writeFile(testInfo.outputPath(`${label}-native.png`), Buffer.from(images.native, 'base64'))
}

async function assertReleased(application: ElectronApplication, page: Page, platform: Platform, ids: number[]): Promise<void> {
  await expect(page.getByRole('dialog', { name: `${NAME[platform]}登录`, exact: true })).toBeHidden()
  await expect.poll(() => application.evaluate(({ webContents }, values) => values.every(id => !webContents.fromId(id)
    || webContents.fromId(id)!.isDestroyed()), ids)).toBe(true)
}

/** Failure evidence records DOM classifications and presentation state, excluding input values. */
async function diagnostics(application: ElectronApplication, page: Page): Promise<unknown> {
  const presentation = await invoke(page, 'getEmbeddedLogin', undefined)
  const native = await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const main = BrowserWindow.getAllWindows()[0]!
    const descendants = (root: View): View[] => root.children.flatMap(child => [child, ...descendants(child)])
    const all = descendants(main.contentView).filter(view => view instanceof WebContentsView
      && view.webContents.id !== main.webContents.id) as Array<InstanceType<typeof WebContentsView>>
    return Promise.all(all.map(async view => {
      const frames = await Promise.all(view.webContents.mainFrame.framesInSubtree.map(async frame => {
        if (!frame.url) return { unavailable: true, documentNotLoaded: true }
        try { return await Promise.race([frame.executeJavaScript(`({url:location.href,localStage:document.getElementById('card')?.dataset.stage,
          captcha:!!document.querySelector('button[data-fixture-captcha]'),transientError:!!document.querySelector('.toast__content'),
          smsControl:Array.from(document.querySelectorAll('.get-sms-code,.phone-send')).map(button=>({text:button.textContent,
            disabled:button.disabled,enabled:button.getAttribute('enabled'),className:button.className,
            visible:button.getBoundingClientRect().width>0&&button.getBoundingClientRect().height>0})),
          media:Array.from(document.querySelectorAll('video,audio')).map(media=>({paused:media.paused}))})`),
          new Promise(resolve => setTimeout(() => resolve({ unavailable: true, timedOut: true }), 1500))]) }
        catch { return { unavailable: true } }
      }))
      return { id: view.webContents.id, visible: view.getVisible(), muted: view.webContents.isAudioMuted(), frames }
    }))
  })
  const local = application.context().pages().find(page => page.url().startsWith('app://login/'))
  const localState = local ? await local.evaluate(async () => {
    const state = await window.loginCard!.state()
    return state ? { stage: state.stage, mode: state.mode, busy: state.busy, sms: state.sms, message: state.message, qr: { status: state.qr.status } } : null
  }).catch(() => null) : null
  return { presentation, native, localState, fixture: await fixture(application) }
}

async function runRepairScenario(testInfo: TestInfo, mode: RepairScenario): Promise<void> {
  const running = await launchApplication('login-repair')
  const evidence: unknown[] = []
  try {
    await openPlayer(running.page)
    let local: Page
    for (const platform of mode === 'sms-captcha' ? ['douyu', 'huya'] as const : []) {
      await setScenario(running.application, 'sms-captcha')
      const account = await accountPage(running.page, platform)
      await account.getByRole('button', { name: '登录', exact: true }).click()
      local = await localPage(running.application)
      const before = await views(running.application, true)
      const initialFixture = await fixture(running.application)
      await expect.poll(async () => (await mediaState(running.application, before.remoteId)).count).toBeGreaterThanOrEqual(2)
      expect(await mediaState(running.application, before.remoteId)).toMatchObject({ muted: true, paused: true })
      expect((await fixture(running.application)).mediaRequests).toBe(0)
      await local.getByRole('tab', { name: '短信登录', exact: true }).click()
      await expect(local.locator('#sms-fields')).toBeVisible()
      await local.locator('#phone').fill('15500000000')
      await local.locator('#accepted').check()
      await expect(local.locator('#send-sms')).toBeEnabled()
      await local.locator('#send-sms').click()
      await expect.poll(async () => {
        const result = await invoke(running.page, 'getEmbeddedLogin', undefined)
        return result.ok && result.value?.presentation === 'captcha'
      }).toBe(true)
      const challenge = await views(running.application)
      expect(challenge).toMatchObject({ localId: before.localId, remoteId: before.remoteId, remoteUrl: before.remoteUrl,
        stable: true, localVisible: false, remoteVisible: true })
      const clipping = await assertCaptchaClipping(running.application, running.page, before.remoteId)
      const during = await fixture(running.application)
      expect(during).toMatchObject({ pendingCaptcha: true, smsSent: 0, phoneChanges: 1, mediaRequests: 0 })
      const sendState = await local.evaluate(() => window.loginCard!.state())
      expect(sendState!.sms).toEqual({ canSend: false, cooldownSeconds: null })
      expect(sendState!.message).toContain('验证')
      expect(await local.locator('#send-sms').textContent()).not.toContain('60')
      expect(await loggedIn(running.page, platform)).toBe(false)
      await completeCaptcha(running.application, before.remoteId)
      await expect.poll(async () => (await fixture(running.application)).smsSent).toBe(1)
      await expect.poll(async () => (await views(running.application)).localVisible).toBe(true)
      await expect.poll(async () => (await fixture(running.application)).pendingCaptcha).toBe(false)
      expect(await views(running.application)).toMatchObject({ localId: before.localId, remoteId: before.remoteId,
        remoteUrl: before.remoteUrl, stable: true, remoteVisible: false })
      expect((await fixture(running.application)).navigationCount).toBe(initialFixture.navigationCount)
      for (const seconds of [37, 12, 0]) {
        await running.application.evaluate(async (_electron, value) => {
          await (globalThis as FixtureGlobal).__streamSyncerTest.setEmbeddedLoginFixtureCooldown(value)
        }, seconds)
        await expect(local.locator('#send-sms')).toHaveText(seconds ? `${seconds} 秒后重发` : '发送验证码')
        await expect(local.locator('#send-sms')).toBeEnabled({ enabled: seconds === 0 })
        expect((await local.evaluate(() => window.loginCard!.state()))!.sms).toEqual({ canSend: seconds === 0, cooldownSeconds: seconds })
        if (seconds === 37) {
          await local.waitForTimeout(1500)
          await expect(local.locator('#send-sms')).toHaveText('37 秒后重发')
        }
      }
      expect(await mediaState(running.application, before.remoteId)).toMatchObject({ muted: true, paused: true })
      expect((await fixture(running.application)).mediaRequests).toBe(0)
      await capture(running.application, local, testInfo, `${platform}-sms-after-captcha`)
      await local.locator('#sms-code').fill('123456')
      await local.getByRole('button', { name: '登录', exact: true }).click()
      await expect(account).toContainText('已登录')
      await expect.poll(() => loggedIn(running.page, platform)).toBe(true)
      await assertReleased(running.application, running.page, platform, [before.localId, before.remoteId])
      const completed = await fixture(running.application)
      expect(completed).toMatchObject({ smsSent: 1, phoneChanges: 1, mediaRequests: 0 })
      evidence.push({ platform, fixture: completed, retainedOriginalView: true, directCooldown: [37, 12, 0], clipping })
    }
    if (mode === 'sms-captcha') return

    await setScenario(running.application, 'password-error')
    const bilibili = await accountPage(running.page, 'bilibili')
    await bilibili.getByRole('button', { name: '登录', exact: true }).click()
    local = await localPage(running.application)
    const passwordViews = await views(running.application, true)
    await expect(local.locator('#password')).toHaveAttribute('type', 'password')
    await expect(local.getByRole('button', { name: '显示密码', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await local.locator('#username').fill('test-account')
    await local.locator('#password').fill('synthetic-password')
    await local.getByRole('button', { name: '显示密码', exact: true }).click()
    await expect(local.locator('#password')).toHaveAttribute('type', 'text')
    await expect(local.getByRole('button', { name: '隐藏密码', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await local.getByRole('button', { name: '隐藏密码', exact: true }).click()
    await expect(local.locator('#password')).toHaveAttribute('type', 'password')
    await local.getByRole('button', { name: '显示密码', exact: true }).click()
    await local.locator('#accepted').check()
    await local.getByRole('button', { name: '登录', exact: true }).click()
    await expect(local.locator('#password')).toHaveValue('')
    await expect(local.locator('#password')).toHaveAttribute('type', 'password')
    const error = local.locator('#message[role="alert"]')
    await expect(error).toContainText(/密码|账号|错误|失败/)
    const shownError = await error.textContent()
    // Wait for the synthetic transient toast to disappear; its local error must stay visible.
    await local.waitForTimeout(1500)
    expect(await running.application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)!
      return contents.executeJavaScript(`document.querySelectorAll('.toast__content').length`)
    }, passwordViews.remoteId)).toBe(0)
    await expect(error).toHaveText(shownError!)
    expect(await loggedIn(running.page, 'bilibili')).toBe(false)
    evidence.push({ platform: 'bilibili', errorRetained: true, fixture: await fixture(running.application) })
    await capture(running.application, local, testInfo, 'password-error')
    await running.page.getByRole('button', { name: '关闭哔哩哔哩登录', exact: true }).click()
    await assertReleased(running.application, running.page, 'bilibili', [passwordViews.localId, passwordViews.remoteId])

  } catch (error) {
    try { evidence.push({ failure: await diagnostics(running.application, running.page) }) } catch { evidence.push({ failureDiagnosticsUnavailable: true }) }
    throw error
  } finally {
    try {
      await mkdir(testInfo.outputDir, { recursive: true })
      await writeFile(testInfo.outputPath('login-repair-evidence.json'), JSON.stringify(evidence, null, 2))
    } finally { await running.close() }
  }
}

test('原生登录短信验证保留原页面, 网页冷却和后台媒体保护', async ({}, testInfo) => {
  test.skip(!visibleE2eWindows, '原生验证码 sendInputEvent 需要窗口获得真实焦点; 设置 STREAM_SYNC_E2E_VISIBLE=1')
  test.setTimeout(180_000)
  await runRepairScenario(testInfo, 'sms-captcha')
})

test('登录密码错误持续显示, 提交后清空密码并恢复隐藏', async ({}, testInfo) => {
  test.setTimeout(90_000)
  await runRepairScenario(testInfo, 'password-error')
})
