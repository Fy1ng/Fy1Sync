import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { Session, View } from 'electron'
import { expect, launchApplication, visibleE2eWindows } from './electron'
import { invoke, openPlayer, openSettings } from './helpers'

type Scenario = 'second-factor-stalled' | 'captcha-phases'
type ChallengePhase = 'loading' | 'interactive' | 'verifying' | 'passed' | 'form'
interface FixtureState { active: boolean; submitted: number; smsSent: number; verified: number; navigationCount: number }
type FixtureGlobal = typeof globalThis & { __streamSyncerTest: {
  setEmbeddedLoginFixture(): void
  setEmbeddedLoginFixtureScenario(value: Scenario): void
  getEmbeddedLoginFixtureState(): FixtureState
} }
type IdentityGlobal = typeof globalThis & { __loginFollowupIdentity?: { local: Session; remote: Session; localId: number; remoteId: number }
  __loginFollowupCompletion?: { timer: ReturnType<typeof setInterval>; samples: Array<{ url: string; completed: boolean }> } }
type PngImage = { width: number; height: number; data: Buffer }
const require = createRequire(import.meta.url)
const PNG = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js')).PNG as {
  sync: { read(bytes: Buffer): PngImage }
}

async function fixture(application: ElectronApplication): Promise<FixtureState> {
  return application.evaluate(() => (globalThis as FixtureGlobal).__streamSyncerTest.getEmbeddedLoginFixtureState())
}

async function begin(application: ElectronApplication, page: Page, selected: Scenario): Promise<Page> {
  await application.evaluate((_electron, next) => {
    if (process.env.STREAM_SYNC_E2E !== '1' || process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Login followup requires an offline disposable profile')
    const hook = (globalThis as FixtureGlobal).__streamSyncerTest
    hook.setEmbeddedLoginFixture()
    hook.setEmbeddedLoginFixtureScenario(next)
  }, selected)
  await openPlayer(page)
  const settings = await openSettings(page, '哔哩哔哩')
  await settings.getByRole('region', { name: '哔哩哔哩账号', exact: true }).getByRole('button', { name: '登录', exact: true }).click()
  await expect.poll(() => application.context().pages().some(item => item.url().startsWith('app://login/'))).toBe(true)
  const local = application.context().pages().find(item => item.url().startsWith('app://login/'))!
  await expect(local.locator('#card')).toHaveAttribute('data-stage', 'form')
  await page.evaluate(() => {
    const scope = window as typeof window & { __loginFollowupHistory?: Array<{ presentation: string | null; at: number }>; __loginFollowupTimer?: number }
    scope.__loginFollowupHistory = []
    scope.__loginFollowupTimer = window.setInterval(() => {
      void window.streamSyncer!.invoke('getEmbeddedLogin', undefined).then(result => {
        scope.__loginFollowupHistory!.push({ presentation: result.ok ? result.value?.presentation ?? null : null, at: Date.now() })
      }).catch(() => {})
    }, 75)
  })
  return local
}

async function views(application: ElectronApplication, remember = false): Promise<{
  localId: number; remoteId: number; remoteUrl: string; localVisible: boolean; remoteVisible: boolean; stable: boolean
}> {
  return application.evaluate(({ BrowserWindow, WebContentsView }, save) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1) throw new Error('Login followup must keep one OS window')
    const main = windows[0]!
    const descendants = (root: View, visible = true): Array<{ view: View; visible: boolean }> => root.children.flatMap(view => {
      const shown = visible && view.getVisible()
      return [{ view, visible: shown }, ...descendants(view, shown)]
    })
    const all = descendants(main.contentView).filter(item => item.view instanceof WebContentsView && item.view.webContents.id !== main.webContents.id)
    const local = all.find(item => (item.view as InstanceType<typeof WebContentsView>).webContents.getURL().startsWith('app://login/'))
    const remote = all.find(item => !(item.view as InstanceType<typeof WebContentsView>).webContents.getURL().startsWith('app://login/'))
    if (all.length !== 2 || !local || !remote) throw new Error('Expected one local and one original official view')
    const localContents = (local.view as InstanceType<typeof WebContentsView>).webContents
    const remoteContents = (remote.view as InstanceType<typeof WebContentsView>).webContents
    const scope = globalThis as IdentityGlobal
    if (save) scope.__loginFollowupIdentity = { local: localContents.session, remote: remoteContents.session, localId: localContents.id, remoteId: remoteContents.id }
    const previous = scope.__loginFollowupIdentity
    return { localId: localContents.id, remoteId: remoteContents.id, remoteUrl: remoteContents.getURL(), localVisible: local.visible,
      remoteVisible: remote.visible, stable: !!previous && previous.local === localContents.session && previous.remote === remoteContents.session
        && previous.localId === localContents.id && previous.remoteId === remoteContents.id }
  }, remember)
}

async function fillPassword(local: Page): Promise<void> {
  await local.getByLabel('账号', { exact: true }).fill('test-account')
  await local.getByLabel('密码', { exact: true }).fill('synthetic-password')
  await local.locator('#accepted').check()
  await local.getByRole('button', { name: '登录', exact: true }).click()
  await expect(local.locator('#password')).toHaveValue('')
}

async function presentation(page: Page): Promise<string | null> {
  const result = await invoke(page, 'getEmbeddedLogin', undefined)
  if (!result.ok) throw new Error('Embedded login state unavailable')
  return result.value?.presentation ?? null
}

async function loggedIn(page: Page): Promise<boolean> {
  const result = await invoke(page, 'loginStatus', undefined)
  if (!result.ok) throw new Error('Bilibili login status unavailable')
  return result.value.bilibili.loggedIn
}

async function setPhase(application: ElectronApplication, remoteId: number, phase: ChallengePhase): Promise<void> {
  await application.evaluate(async ({ webContents }, value) => {
    const remote = webContents.fromId(value.remoteId)
    if (!remote) throw new Error('Original fixture document missing')
    await remote.executeJavaScript(`globalThis.__fixtureSetChallengePhase(${JSON.stringify(value.phase)})`)
  }, { remoteId, phase })
}

async function challengeState(application: ElectronApplication, remoteId: number): Promise<{ phase: ChallengePhase; clicks: number }> {
  return application.evaluate(async ({ webContents }, id) => {
    const remote = webContents.fromId(id)
    if (!remote) throw new Error('Original fixture document missing')
    return await remote.executeJavaScript('({phase:globalThis.__fixtureChallengePhase,clicks:globalThis.__fixtureChallengeClicks})') as { phase: ChallengePhase; clicks: number }
  }, remoteId)
}

async function assertLocalWait(application: ElectronApplication, page: Page, local: Page): Promise<void> {
  await expect.poll(() => presentation(page)).toBe('form')
  await expect(local.locator('#basic')).toBeVisible()
  await expect(local.locator('#official')).toBeEnabled()
  expect(await views(application)).toMatchObject({ stable: true, localVisible: true, remoteVisible: false })
  expect((await local.evaluate(() => window.loginCard!.state()))?.stage).not.toBe('official')
  expect(await loggedIn(page)).toBe(false)
  expect((await fixture(application)).submitted).toBe(1)
}

/** Native capture includes the clipped original WCV, without compositing or copying its DOM. */
async function captureCaptcha(application: ElectronApplication, local: Page, remoteId: number, testInfo: TestInfo): Promise<unknown> {
  expect(await local.locator('[data-secret]').evaluateAll(nodes => nodes.every(node => (node as HTMLInputElement).value === ''))).toBe(true)
  const result = await application.evaluate(async ({ BrowserWindow, WebContentsView, desktopCapturer, screen }, id) => {
    const main = BrowserWindow.getAllWindows()[0]!
    const parents = (root: View): Array<{ parent: View; child: View }> => root.children.flatMap(child => [{ parent: root, child }, ...parents(child)])
    const targets = parents(main.contentView).filter(item => item.child instanceof WebContentsView && item.child.webContents.id === id)
    if (targets.length !== 1) throw new Error('Captcha document duplicated or missing')
    const target = targets[0]!
    const remote = (target.child as InstanceType<typeof WebContentsView>).webContents
    const geometry = await remote.executeJavaScript(`(() => {
      const button=document.querySelector('button[data-fixture-captcha]');
      if(!button)throw new Error('Fixture challenge button missing');
      const panel=button.closest('.geetest_panel_box,.geetest_panel,.geetest4_box');
      if(!panel)throw new Error('Fixture challenge panel missing');
      const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};
      return{panel:rect(panel),button:rect(button),background:getComputedStyle(document.body).backgroundColor,innerWidth,innerHeight};
    })()`) as { panel: { x: number; y: number; width: number; height: number }; button: { x: number; y: number; width: number; height: number }; background: string; innerWidth: number; innerHeight: number }
    const content = main.getContentBounds(), dpi = screen.getDisplayMatching(main.getBounds()).scaleFactor
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: Math.round(content.width * dpi), height: Math.round(content.height * dpi) } })
    const source = sources.find(item => item.id === main.getMediaSourceId())
    if (!source || source.thumbnail.isEmpty()) throw new Error('Native login window capture missing')
    const backdrop = (await remote.capturePage({ x: 0, y: 0, width: 1, height: 1 })).toBitmap()
    return { nested: target.parent !== main.contentView, host: target.parent.getBounds(), remote: target.child.getBounds(),
      zoom: remote.getZoomFactor(), dpi, content, geometry, backdropRgb: [backdrop[2], backdrop[1], backdrop[0]], png: source.thumbnail.toPNG().toString('base64') }
  }, remoteId)
  expect(result.nested).toBe(true)
  expect(result.geometry.panel).toMatchObject({ width: 340, height: 410 })
  expect(result.host.width).toBeCloseTo(340 * result.zoom, 0)
  expect(result.host.height).toBeCloseTo(410 * result.zoom, 0)
  const rect = result.geometry.button, panel = result.geometry.panel
  expect(rect.x).toBeGreaterThanOrEqual(panel.x)
  expect(rect.y).toBeGreaterThanOrEqual(panel.y)
  expect(rect.x + rect.width).toBeLessThanOrEqual(panel.x + panel.width)
  expect(rect.y + rect.height).toBeLessThanOrEqual(panel.y + panel.height)
  const image = PNG.sync.read(Buffer.from(result.png, 'base64'))
  const rgb = result.geometry.background.match(/\d+/g)!.slice(0, 3).map(Number)
  const scaleX = image.width / result.content.width, scaleY = image.height / result.content.height
  const left = Math.round(result.host.x * scaleX), top = Math.round(result.host.y * scaleY)
  const right = Math.round((result.host.x + result.host.width) * scaleX), bottom = Math.round((result.host.y + result.host.height) * scaleY)
  let backgroundPixels = 0
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * image.width + x) * 4
    if ([rgb, result.backdropRgb].some(color => image.data[offset] === color[0] && image.data[offset + 1] === color[1] && image.data[offset + 2] === color[2])) backgroundPixels++
  }
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(testInfo.outputPath('interactive-native-window.png'), Buffer.from(result.png, 'base64'))
  expect(backgroundPixels).toBe(0)
  const { png: _png, ...evidence } = result
  return { ...evidence, nativePixels: { width: image.width, height: image.height }, backgroundPixels }
}

async function clickOriginalCaptcha(application: ElectronApplication, remoteId: number): Promise<void> {
  await application.evaluate(async ({ webContents }, id) => {
    const remote = webContents.fromId(id)
    if (!remote) throw new Error('Original fixture captcha missing')
    const point = await remote.executeJavaScript(`(() => { const r=document.querySelector('button[data-fixture-captcha]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`) as { x: number; y: number }
    const zoom = remote.getZoomFactor(), x = Math.round(point.x * zoom), y = Math.round(point.y * zoom)
    remote.sendInputEvent({ type: 'mouseMove', x, y })
    remote.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    remote.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }, remoteId)
}

async function stopHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & { __loginFollowupTimer?: number }
    if (scope.__loginFollowupTimer !== undefined) window.clearInterval(scope.__loginFollowupTimer)
  }).catch(() => {})
}

async function failureEvidence(application: ElectronApplication, page: Page, testInfo: TestInfo): Promise<void> {
  const counters = await fixture(application).catch(() => null)
  const current = await views(application).catch(() => null)
  const card = application.context().pages().find(item => item.url().startsWith('app://login/'))
  const cardState = await card?.evaluate(() => window.loginCard!.state()).catch(() => null)
  const official = await application.evaluate(async ({ webContents }, id) => {
    const remote = id ? webContents.fromId(id) : null
    if (!remote) return null
    return await remote.executeJavaScript(`({url:location.href,toast:document.querySelector('.toast__content')?.textContent,codeLength:document.querySelector('input.risk-input-dom')?.value.length,buttons:Array.from(document.querySelectorAll('.risk-bottom-btn')).map(button=>({text:button.textContent,disabled:button.disabled}))})`)
  }, current?.remoteId ?? null).catch(() => null)
  const samples = await application.evaluate(() => {
    const monitor = (globalThis as IdentityGlobal).__loginFollowupCompletion
    if (monitor) clearInterval(monitor.timer)
    return monitor?.samples ?? []
  }).catch(() => [])
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(testInfo.outputPath('failure-evidence.json'), JSON.stringify({ counters, current, cardState, official, samples, presentation: await presentation(page).catch(() => null) }, null, 2))
}

test('二次验证成功但官网停留动画时仍自动完成并释放双视图', async ({}, testInfo) => {
  const running = await launchApplication('login-followup-stalled')
  try {
    const local = await begin(running.application, running.page, 'second-factor-stalled')
    const original = await views(running.application, true)
    await fillPassword(local)
    await expect(local.locator('#card')).toHaveAttribute('data-stage', 'verification')
    expect(await views(running.application)).toMatchObject({ stable: true, localVisible: true, remoteVisible: false })
    expect(await loggedIn(running.page)).toBe(false)
    await local.locator('#second-send').click()
    await expect.poll(async () => (await fixture(running.application)).smsSent).toBe(1)
    await running.application.evaluate(({ webContents }, id) => {
      const scope = globalThis as IdentityGlobal
      const samples: Array<{ url: string; completed: boolean }> = []
      const timer = setInterval(() => {
        const remote = webContents.fromId(id)
        if (!remote) { clearInterval(timer); return }
        void remote.executeJavaScript(`({url:location.href,completed:!!document.querySelector('.toast_wp .toast__img_loading')&&/验证成功/.test(document.querySelector('.toast_wp .toast__content')?.textContent||'')})`).then(sample => samples.push(sample as { url: string; completed: boolean })).catch(() => {})
      }, 20)
      scope.__loginFollowupCompletion = { timer, samples }
    }, original.remoteId)
    await local.locator('#verification-code').fill('123456')
    await local.getByRole('button', { name: '继续', exact: true }).click()
    await expect(running.page.getByRole('dialog', { name: '哔哩哔哩登录', exact: true })).toBeHidden()
    await expect.poll(() => loggedIn(running.page)).toBe(true)
    await expect.poll(() => running.application.evaluate(({ webContents }, ids) => ids.every(id => !webContents.fromId(id)), [original.localId, original.remoteId])).toBe(true)
    expect(await fixture(running.application)).toMatchObject({ active: false, submitted: 1, smsSent: 1, verified: 1 })
    const samples = await running.application.evaluate(() => {
      const monitor = (globalThis as IdentityGlobal).__loginFollowupCompletion!
      clearInterval(monitor.timer)
      return monitor.samples
    })
    expect(samples.some(item => item.completed && new URL(item.url).pathname === '/pc/passport/riskVerify')).toBe(true)
    expect(samples.every(item => new URL(item.url).pathname === '/pc/passport/riskVerify')).toBe(true)
    await mkdir(testInfo.outputDir, { recursive: true })
    await writeFile(testInfo.outputPath('stalled-completion-evidence.json'), JSON.stringify({ original, counters: await fixture(running.application), samples }, null, 2))
  } catch (error) {
    await failureEvidence(running.application, running.page, testInfo)
    throw error
  } finally { await stopHistory(running.page); await running.close() }
})

test('验证码各动画和长等待保持统一表单, 仅交互面板裁剪且显式官网接续不换会话', async ({}, testInfo) => {
  test.skip(!visibleE2eWindows, 'desktopCapturer 原生窗口截图需要可见窗口; 设置 STREAM_SYNC_E2E_VISIBLE=1')
  test.setTimeout(120_000)
  const running = await launchApplication('login-followup-captcha')
  const evidence: unknown[] = []
  try {
    const local = await begin(running.application, running.page, 'captcha-phases')
    const original = await views(running.application, true)
    await fillPassword(local)
    await expect.poll(() => challengeState(running.application, original.remoteId)).toMatchObject({ phase: 'loading', clicks: 0 })
    await assertLocalWait(running.application, running.page, local)
    await local.waitForTimeout(13_000)
    await assertLocalWait(running.application, running.page, local)
    await setPhase(running.application, original.remoteId, 'interactive')
    await expect.poll(() => presentation(running.page)).toBe('captcha')
    expect(await views(running.application)).toMatchObject({ stable: true, localVisible: false, remoteVisible: true })
    evidence.push(await captureCaptcha(running.application, local, original.remoteId, testInfo))
    await clickOriginalCaptcha(running.application, original.remoteId)
    await expect.poll(() => challengeState(running.application, original.remoteId)).toMatchObject({ phase: 'verifying', clicks: 1 })
    await assertLocalWait(running.application, running.page, local)
    await local.waitForTimeout(13_000)
    await assertLocalWait(running.application, running.page, local)
    await setPhase(running.application, original.remoteId, 'passed')
    await assertLocalWait(running.application, running.page, local)
    await local.waitForTimeout(1200)
    await assertLocalWait(running.application, running.page, local)
    await setPhase(running.application, original.remoteId, 'form')
    await assertLocalWait(running.application, running.page, local)
    const history = await running.page.evaluate(() => (window as typeof window & { __loginFollowupHistory: Array<{ presentation: string | null; at: number }> }).__loginFollowupHistory)
    expect(history.length).toBeGreaterThan(200)
    expect(history.some(item => item.presentation === 'official')).toBe(false)
    expect(history.some(item => item.presentation === 'captcha')).toBe(true)
    await local.locator('#official').click()
    await expect.poll(() => presentation(running.page)).toBe('official')
    expect(await views(running.application)).toMatchObject({ stable: true, localVisible: false, remoteVisible: true })
    await running.page.getByRole('button', { name: /^(返回统一登录|返回登录)$/ }).click()
    await assertLocalWait(running.application, running.page, local)
    expect(await challengeState(running.application, original.remoteId)).toMatchObject({ phase: 'form', clicks: 1 })
    expect(await fixture(running.application)).toMatchObject({ submitted: 1, verified: 0, smsSent: 0 })
    evidence.push({ original, final: await views(running.application), counters: await fixture(running.application), history })
    await mkdir(testInfo.outputDir, { recursive: true })
    await writeFile(testInfo.outputPath('captcha-phases-evidence.json'), JSON.stringify(evidence, null, 2))
  } catch (error) {
    await failureEvidence(running.application, running.page, testInfo)
    throw error
  } finally { await stopHistory(running.page); await running.close() }
})
