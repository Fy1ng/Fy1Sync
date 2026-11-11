import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test, type ElectronApplication, type Page, type TestInfo } from '@playwright/test'
import type { Session, View, WebPreferences } from 'electron'
import type { LoginCardState } from '../electron/loginCardContracts'
import { expect, launchApplication } from './electron'
import { invoke, openPlayer, openSettings } from './helpers'
import { captureEmbeddedWindow } from './captureEmbeddedWindow'

type Scenario = 'second-factor' | 'challenge' | 'unknown'
interface FixtureState { platform: string | null; active: boolean; requests: number; phase: string | null
  submitted: number; smsSent: number; verified: number; qrPolls: number; sessionId?: string }
type FixtureGlobal = typeof globalThis & { __streamSyncerTest: {
  setEmbeddedLoginFixture(): void
  setEmbeddedLoginFixtureScenario(scenario: Scenario): void
  getEmbeddedLoginFixtureState(): FixtureState
} }
type IdentityGlobal = typeof globalThis & { __unifiedLoginIdentity?: { remote: Session; local: Session; remoteId: number; localId: number } }
type PngImage = { width: number; height: number; data: Buffer }
const require = createRequire(import.meta.url)
const PNG = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js')).PNG as {
  sync: { read(input: Buffer): PngImage; write(image: PngImage): Buffer }
}

async function fixture(application: ElectronApplication): Promise<FixtureState> {
  return application.evaluate(() => (globalThis as FixtureGlobal).__streamSyncerTest.getEmbeddedLoginFixtureState())
}
async function scenario(application: ElectronApplication, selected: Scenario): Promise<void> {
  await application.evaluate((_electron, next) => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Unified login scenario requires an offline disposable profile')
    const hook = (globalThis as FixtureGlobal).__streamSyncerTest
    hook.setEmbeddedLoginFixture()
    hook.setEmbeddedLoginFixtureScenario(next)
  }, selected)
}
async function cardPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.context().pages().some(page => page.url().startsWith('app://login/'))).toBe(true)
  const page = application.context().pages().find(page => page.url().startsWith('app://login/'))!
  await expect(page.locator('#card')).toHaveAttribute('data-stage', 'form')
  return page
}
async function state(page: Page): Promise<LoginCardState | null> {
  return page.evaluate(() => window.loginCard!.state())
}
async function loggedIn(page: Page): Promise<boolean> {
  const result = await invoke(page, 'loginStatus', undefined)
  if (!result.ok) throw new Error('Bilibili login status is unavailable')
  return result.value.bilibili.loggedIn
}

/** Retain only session references and public view IDs to detect accidental replacement. */
async function identity(application: ElectronApplication, save = false): Promise<{ localId: number; remoteId: number; remoteUrl: string; stable: boolean }> {
  return application.evaluate(async ({ BrowserWindow, WebContentsView }, remember) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1) throw new Error('Unified login must keep one OS window')
    const main = windows[0]!
    const descendants = (root: View): View[] => root.children.flatMap(child => [child, ...descendants(child)])
    const views = descendants(main.contentView).filter(view => view instanceof WebContentsView
      && view.webContents.id !== main.webContents.id) as Array<InstanceType<typeof WebContentsView>>
    const local = views.find(view => view.webContents.getURL().startsWith('app://login/'))
    const remote = views.find(view => !view.webContents.getURL().startsWith('app://login/'))
    if (views.length !== 2 || !local || !remote) throw new Error('Unified login requires separate local and official views')
    for (const view of views) {
      const contents = view.webContents as typeof view.webContents & { getLastWebPreferences(): WebPreferences }
      const prefs = contents.getLastWebPreferences()
      const capabilities = await contents.executeJavaScript('({localBridge:typeof window.loginCard === "object",appBridge:typeof window.streamSyncer !== "undefined"})') as { localBridge: boolean; appBridge: boolean }
      if (prefs.nodeIntegration || !prefs.sandbox || !prefs.contextIsolation || prefs.webSecurity === false
        || capabilities.appBridge || capabilities.localBridge !== (view === local)) throw new Error('Unified view preferences are not isolated')
    }
    if (local.webContents.session === remote.webContents.session || local.webContents.session === main.webContents.session
      || remote.webContents.session === main.webContents.session) throw new Error('Unified views must not share account or app sessions')
    const scope = globalThis as IdentityGlobal
    if (remember) scope.__unifiedLoginIdentity = { remote: remote.webContents.session, local: local.webContents.session,
      remoteId: remote.webContents.id, localId: local.webContents.id }
    const previous = scope.__unifiedLoginIdentity
    return { localId: local.webContents.id, remoteId: remote.webContents.id, remoteUrl: remote.webContents.getURL(), stable: !!previous
      && previous.remote === remote.webContents.session && previous.local === local.webContents.session
      && previous.remoteId === remote.webContents.id && previous.localId === local.webContents.id }
  }, save)
}

async function fillSyntheticPassword(page: Page): Promise<void> {
  await page.getByLabel('账号', { exact: true }).fill('test-account')
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password')
  await page.locator('#accepted').check()
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('#password')).toHaveValue('')
}

/** Capture only after all synthetic password and OTP fields have cleared. */
async function capture(application: ElectronApplication, card: Page, testInfo: TestInfo, label: string): Promise<void> {
  expect(await card.locator('[data-secret]').evaluateAll(nodes => nodes.every(node => (node as HTMLInputElement).value === ''))).toBe(true)
  const result = await captureEmbeddedWindow(application)
  const shell = PNG.sync.read(Buffer.from(result.shell, 'base64'))
  const child = PNG.sync.read(Buffer.from(result.scaled, 'base64'))
  const x = Math.round(result.bounds.x * shell.width / result.content.width)
  const y = Math.round(result.bounds.y * shell.height / result.content.height)
  expect(x + child.width).toBeLessThanOrEqual(shell.width)
  expect(y + child.height).toBeLessThanOrEqual(shell.height)
  for (let row = 0; row < child.height; row += 1) child.data.copy(shell.data,
    ((y + row) * shell.width + x) * 4, row * child.width * 4, (row + 1) * child.width * 4)
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(testInfo.outputPath(`${label}-card.png`), PNG.sync.write(shell))
  await writeFile(testInfo.outputPath(`${label}-native.png`), Buffer.from(result.native, 'base64'))
}

async function assertMainHasNoCredentials(page: Page): Promise<void> {
  const inspection = await page.evaluate(async () => {
    const result = await window.streamSyncer!.invoke('getEmbeddedLogin', undefined)
    const value = result.ok ? result.value : null
    return { bridgeKeys: Object.keys(window.streamSyncer!), loginCardAbsent: typeof window.loginCard === 'undefined',
      keys: value ? Object.keys(value) : [], payloadContainsInput: /synthetic-password|test-account|123456|data:image/.test(JSON.stringify(value)) }
  })
  expect(inspection.loginCardAbsent).toBe(true)
  expect(inspection.bridgeKeys.some(key => /credential|password|loginCard|secondSubmit/i.test(key))).toBe(false)
  expect(inspection.payloadContainsInput).toBe(false)
  expect(inspection.keys.every(key => ['id', 'platform', 'purpose', 'phase', 'accountLabel', 'message', 'presentation'].includes(key))).toBe(true)
}

test('统一登录二次验证不误成功, 官方接续保留会话且返回不重复提交', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const running = await launchApplication('unified-login')
  const evidence: unknown[] = []
  try {
    await scenario(running.application, 'second-factor')
    await openPlayer(running.page)
    let settings = await openSettings(running.page, '哔哩哔哩')
    let account = settings.getByRole('region', { name: '哔哩哔哩账号', exact: true })
    await account.getByRole('button', { name: '登录', exact: true }).click()
    let local = await cardPage(running.application)
    expect(await local.evaluate(() => typeof window.streamSyncer)).toBe('undefined')
    expect(await identity(running.application, true)).toMatchObject({ stable: true })
    await assertMainHasNoCredentials(running.page)
    await fillSyntheticPassword(local)
    await expect(local.locator('#card')).toHaveAttribute('data-stage', 'verification')
    await expect(local.getByRole('heading', { name: '安全验证', exact: true })).toBeVisible()
    await expect(local.locator('#basic')).toBeHidden()
    expect(await loggedIn(running.page)).toBe(false)
    await expect.poll(async () => (await state(local))?.qr.status).toBe('paused')
    expect(await identity(running.application)).toMatchObject({ stable: true })
    await assertMainHasNoCredentials(running.page)
    let counters = await fixture(running.application)
    expect(counters).toMatchObject({ submitted: 1, smsSent: 0, verified: 0 })
    const qrPolls = counters.qrPolls
    await local.locator('#second-send').click()
    await expect.poll(async () => (await fixture(running.application)).smsSent).toBe(1)
    await expect(local.locator('#second-send')).toHaveText(/(?:59|60) 秒后重发/)
    await expect(local.locator('#second-send')).toBeDisabled()
    expect((await state(local))!.sms.cooldownSeconds).toBeGreaterThan(55)
    expect((await state(local))!.sms.canSend).toBe(false)
    // Cross an official poll interval to prove 2FA does not keep QR polling alive.
    await local.waitForTimeout(1200)
    expect((await fixture(running.application)).qrPolls).toBe(qrPolls)
    expect(await loggedIn(running.page)).toBe(false)
    await capture(running.application, local, testInfo, 'second-factor')
    await local.locator('#verification-code').fill('123456')
    await local.getByRole('button', { name: '继续', exact: true }).click()
    await expect(running.page.getByRole('dialog', { name: '哔哩哔哩登录', exact: true })).toBeHidden()
    await expect(account.getByText('已登录', { exact: true })).toBeVisible()
    expect(await loggedIn(running.page)).toBe(true)
    counters = await fixture(running.application)
    expect(counters).toMatchObject({ submitted: 1, smsSent: 1, verified: 1 })
    evidence.push({ scenario: 'second-factor', counters })

    await account.getByRole('button', { name: '退出', exact: true }).click()
    await expect.poll(() => loggedIn(running.page)).toBe(false)
    for (const selected of ['challenge', 'unknown'] as const) {
      await scenario(running.application, selected)
      await account.getByRole('button', { name: '登录', exact: true }).click()
      local = await cardPage(running.application)
      const before = await identity(running.application, true)
      const original = await invoke(running.page, 'getEmbeddedLogin', undefined)
      expect(original.ok && original.value?.id).toBeTruthy()
      await fillSyntheticPassword(local)
      await expect.poll(async () => {
        const result = await invoke(running.page, 'getEmbeddedLogin', undefined)
        return result.ok && result.value?.presentation === 'form'
      }).toBe(true)
      await expect(local.locator('#message')).toContainText('官方验证页面')
      await expect(local.locator('#basic')).toBeVisible()
      await expect(local.locator('#official')).toBeVisible()
      expect((await state(local))?.stage).not.toBe('official')
      const waiting = await identity(running.application)
      expect(waiting).toMatchObject({ localId: before.localId, remoteId: before.remoteId, stable: true })
      const returnButton = running.page.getByRole('button', { name: /^(返回统一登录|返回登录)$/ })
      await expect(returnButton).toBeHidden()
      await local.locator('#official').click()
      await expect.poll(async () => {
        const result = await invoke(running.page, 'getEmbeddedLogin', undefined)
        return result.ok && result.value?.presentation === 'official'
      }).toBe(true)
      const challenged = await identity(running.application)
      expect(challenged).toMatchObject({ localId: before.localId, remoteId: before.remoteId, stable: true })
      await expect(returnButton).toBeVisible()
      expect(await loggedIn(running.page)).toBe(false)
      const current = await invoke(running.page, 'getEmbeddedLogin', undefined)
      expect(current.ok && current.value?.id).toBe(original.ok && original.value?.id)
      await assertMainHasNoCredentials(running.page)
      await returnButton.click()
      await expect.poll(async () => {
        const result = await invoke(running.page, 'getEmbeddedLogin', undefined)
        return result.ok && result.value?.presentation === 'form'
      }).toBe(true)
      await expect(local.locator('#basic')).toBeVisible()
      expect(await identity(running.application)).toEqual(challenged)
      await capture(running.application, local, testInfo, `${selected}-returned`)
      expect((await fixture(running.application)).submitted).toBe(1)
      expect(await loggedIn(running.page)).toBe(false)
      evidence.push({ scenario: selected, counters: await fixture(running.application), identity: challenged })
      await running.page.getByRole('button', { name: '关闭哔哩哔哩登录', exact: true }).click()
      await expect(running.page.getByRole('dialog', { name: '哔哩哔哩登录', exact: true })).toBeHidden()
      // Keep the account locator tied to the still-open settings page.
      settings = await openSettings(running.page, '哔哩哔哩')
      account = settings.getByRole('region', { name: '哔哩哔哩账号', exact: true })
      if (selected === 'challenge') {
        // The next scenario also begins signed out; its loop must not require a logout button.
        await expect(account.getByText('未登录', { exact: true })).toBeVisible()
      }
    }
  } finally {
    try {
      const activeCard = running.application.context().pages().find(page => page.url().startsWith('app://login/'))
      if (activeCard) evidence.push({ finalCounters: await fixture(running.application), finalCard: await state(activeCard), finalIdentity: await identity(running.application) })
      await mkdir(testInfo.outputDir, { recursive: true })
      await writeFile(testInfo.outputPath('unified-login-evidence.json'), JSON.stringify(evidence, null, 2))
    } finally { await running.close() }
  }
})
