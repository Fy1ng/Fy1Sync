import type { ElectronApplication, Page } from '@playwright/test'
import type { View } from 'electron'
import { expect, test } from './electron'
import { invoke, openPlayer, openSettings } from './helpers'

type FixtureRuntime = typeof globalThis & { __streamSyncerTest: {
  setDouyinEmbeddedLoginFixture(scenario?: 'form' | 'challenge' | 'password-error' | 'account-verification'): void
  completeDouyinEmbeddedLoginFixture(authenticated: boolean): Promise<void>
  getDouyinEmbeddedLoginFixtureState(): { active: boolean; submitted: number; smsSent: number }
} }

async function cardPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.context().pages().some(page => page.url().startsWith('app://login/'))).toBe(true)
  const card = application.context().pages().find(page => page.url().startsWith('app://login/'))!
  await expect(card.locator('#card')).toHaveAttribute('data-stage', 'form')
  return card
}

test('抖音内嵌卡片在主窗口登录退出, 匿名会话不算登录且凭据不进入播放器', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture())
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  const account = settings.getByRole('region', { name: '抖音', exact: true })
  await expect(account.getByText('未登录', { exact: true })).toBeVisible()
  await account.getByRole('button', { name: '登录', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '抖音登录', exact: true })
  await expect(overlay).toBeVisible()
  const card = await cardPage(electronApp)
  await expect(card.locator('#qr-image')).toBeVisible()
  await expect(card.getByRole('tab', { name: '密码登录', exact: true })).toBeVisible()
  await expect(card.getByRole('tab', { name: '短信登录', exact: true })).toBeVisible()
  const isolation = await electronApp.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length !== 1) throw new Error('Embedded login opened another OS window')
    const main = windows[0]!
    const children = (view: View): View[] => view.children.flatMap(child => [child, ...children(child)])
    const views = children(main.contentView).filter(view => view instanceof WebContentsView
      && view.webContents.id !== main.webContents.id) as InstanceType<typeof WebContentsView>[]
    const local = views.find(view => view.webContents.getURL().startsWith('app://login/'))
    const remote = views.find(view => view.webContents.getURL().startsWith('https://'))
    if (!local || !remote) throw new Error('Expected isolated local and official views')
    return { windows: windows.length, views: views.length,
      separate: local.webContents.session !== remote.webContents.session && remote.webContents.session !== main.webContents.session,
      local: await local.webContents.executeJavaScript('({app:typeof window.streamSyncer,card:typeof window.loginCard,require:typeof require})'),
      remote: await remote.webContents.executeJavaScript('({app:typeof window.streamSyncer,card:typeof window.loginCard,require:typeof require})'),
    }
  })
  expect(isolation).toEqual({ windows: 1, views: 2, separate: true,
    local: { app: 'undefined', card: 'object', require: 'undefined' },
    remote: { app: 'undefined', card: 'undefined', require: 'undefined' } })
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.completeDouyinEmbeddedLoginFixture(false))
  const anonymous = await invoke(page, 'loginStatus', undefined)
  expect(anonymous.ok && anonymous.value.douyin.loggedIn).toBe(false)
  await expect(overlay).toBeVisible()
  const publicState = await invoke(page, 'getEmbeddedLogin', undefined)
  expect(JSON.stringify(publicState)).not.toMatch(/synthetic-embedded-session|data:image|sessionid|password|smsCode/)
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.completeDouyinEmbeddedLoginFixture(true))
  await expect(overlay).toBeHidden()
  await expect(account.locator('.row-split > span').first()).toHaveText(/^已登录(?:, .* 到期)?$/)
  const signedIn = await invoke(page, 'loginStatus', undefined)
  expect(signedIn.ok && signedIn.value.douyin.loggedIn).toBe(true)
  expect(JSON.stringify(signedIn)).not.toContain('synthetic-embedded-session')
  await account.getByRole('button', { name: '退出', exact: true }).click()
  await expect(account.getByText('未登录', { exact: true })).toBeVisible()
  const signedOut = await invoke(page, 'loginStatus', undefined)
  expect(signedOut.ok && signedOut.value.douyin.cookieCount).toBe(0)
  await account.getByRole('button', { name: '登录', exact: true }).click()
  await expect(overlay).toBeVisible()
  await cardPage(electronApp)
  await overlay.getByRole('button', { name: '关闭抖音登录', exact: true }).click()
  await expect(overlay).toBeHidden()
  await expect(account.getByText('未登录', { exact: true })).toBeVisible()
  await expect.poll(() => electronApp.context().pages().filter(value => value.url().startsWith('app://login/')).length).toBe(0)
})

test('抖音卡片只提交一次合成短信和密码操作, 验证码保留在原官方视图', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture('challenge'))
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  await settings.getByRole('region', { name: '抖音', exact: true }).getByRole('button', { name: '登录', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '抖音登录', exact: true })
  const card = await cardPage(electronApp)
  await card.getByRole('tab', { name: '短信登录', exact: true }).click()
  await card.locator('#phone').fill('13800000000')
  await card.locator('#accepted').check()
  await card.getByRole('button', { name: '发送验证码', exact: true }).click()
  await expect.poll(() => electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState().smsSent)).toBe(1)
  await expect(card.locator('#send-sms')).toBeDisabled()
  await card.getByRole('tab', { name: '密码登录', exact: true }).click()
  await card.getByLabel('账号', { exact: true }).fill('13800000000')
  await card.getByLabel('密码', { exact: true }).fill('synthetic-password-only')
  await card.getByRole('button', { name: '登录', exact: true }).click()
  await expect(card.locator('#password')).toHaveValue('')
  await expect.poll(async () => {
    const state = await invoke(page, 'getEmbeddedLogin', undefined)
    return state.ok ? state.value?.presentation : null
  }).toBe('captcha')
  await expect(overlay.getByRole('heading', { name: '安全验证' })).toBeVisible()
  const counts = await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState())
  expect(counts).toMatchObject({ submitted: 1, smsSent: 1 })
  const publicState = await invoke(page, 'getEmbeddedLogin', undefined)
  expect(JSON.stringify(publicState)).not.toMatch(/13800000000|synthetic-password-only|data:image/)
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(false)
  await overlay.getByRole('button', { name: '关闭抖音登录', exact: true }).click()
  await expect(overlay).toBeHidden()
})

test('抖音登录按需加载原生身份验证, 完成验证后才接收登录态', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture('account-verification'))
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  const account = settings.getByRole('region', { name: '抖音', exact: true })
  await account.getByRole('button', { name: '登录', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '抖音登录', exact: true })
  const local = await cardPage(electronApp)
  await local.getByRole('tab', { name: '密码登录', exact: true }).click()
  await local.getByLabel('账号', { exact: true }).fill('13800000000')
  await local.getByLabel('密码', { exact: true }).fill('synthetic-password-only')
  await local.locator('#accepted').check()
  await local.getByRole('button', { name: '登录', exact: true }).click()
  await expect(overlay.getByRole('heading', { name: '安全验证', exact: true })).toBeVisible()
  const official = electronApp.context().pages().find(value => value.url() === 'https://live.douyin.com/')!
  await expect(official.getByRole('button', { name: '完成离线验证', exact: true })).toBeVisible()
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow, WebContentsView }) => {
    const owner = BrowserWindow.getAllWindows()[0]!
    const descendants = (view: View): View[] => view.children.flatMap(child => [child, ...descendants(child)])
    const remote = descendants(owner.contentView).find(view => view instanceof WebContentsView && view.webContents.getURL() === 'https://live.douyin.com/') as InstanceType<typeof WebContentsView>
    const host = descendants(owner.contentView).find(view => view.children.includes(remote))
    return { visible: Boolean(remote?.getVisible() && host?.getVisible()), bounds: host?.getBounds() ?? null }
  })).toMatchObject({ visible: true, bounds: { width: 726, height: 483 } })
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.completeDouyinEmbeddedLoginFixture(true))
  await page.waitForTimeout(1000)
  await expect(overlay).toBeVisible()
  const pending = await invoke(page, 'loginStatus', undefined)
  expect(pending.ok && pending.value.douyin.loggedIn).toBe(false)
  const counts = await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState())
  expect(counts).toMatchObject({ submitted: 1, smsSent: 0 })
  await official.getByRole('button', { name: '完成离线验证', exact: true }).click()
  await expect(overlay).toBeHidden()
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(true)
})
