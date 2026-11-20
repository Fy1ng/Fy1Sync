import type { ElectronApplication, Page } from '@playwright/test'
import type { View } from 'electron'
import { expect, test } from './electron'
import { invoke, openPlayer, openSettings } from './helpers'

type FixtureRuntime = typeof globalThis & { __streamSyncerTest: {
  setDouyinEmbeddedLoginFixture(scenario?: 'form' | 'challenge' | 'password-error' | 'account-verification'): void
  completeDouyinEmbeddedLoginFixture(authenticated: boolean): Promise<void>
  getDouyinEmbeddedLoginFixtureState(): { active: boolean; requests: number; submitted: number; smsSent: number }
} }

async function cardPage(application: ElectronApplication): Promise<Page> {
  await expect.poll(() => application.context().pages().some(page => page.url().startsWith('app://login/'))).toBe(true)
  const card = application.context().pages().find(page => page.url().startsWith('app://login/'))!
  await expect(card.locator('#card')).toHaveAttribute('data-stage', 'form')
  return card
}

test('抖音纯HTTP卡片在主窗口登录退出, 匿名会话不算登录且凭据不进入播放器', async ({ page, electronApp }) => {
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
    if (!local || remote) throw new Error('HTTP login must contain only its isolated local card')
    return { windows: windows.length, views: views.length,
      separate: local.webContents.session !== main.webContents.session,
      local: await local.webContents.executeJavaScript('({app:typeof window.streamSyncer,card:typeof window.loginCard,require:typeof require})'),
    }
  })
  expect(isolation).toEqual({ windows: 1, views: 1, separate: true,
    local: { app: 'undefined', card: 'object', require: 'undefined' } })
  await expect(card.locator('#official')).toBeHidden()
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
  const confirmLogout = account.getByRole('button', { name: '确认退出', exact: true })
  const cancelLogout = account.getByRole('button', { name: '取消', exact: true })
  await expect(confirmLogout).toBeVisible()
  await expect(cancelLogout).toBeFocused()
  expect(await invoke(page, 'loginStatus', undefined)).toMatchObject({ ok: true, value: { douyin: { loggedIn: true } } })
  await page.keyboard.press('Escape')
  await expect(confirmLogout).toBeHidden()
  await expect(settings).toBeVisible()
  await expect(account.getByRole('button', { name: '退出', exact: true })).toBeVisible()
  expect(await invoke(page, 'loginStatus', undefined)).toMatchObject({ ok: true, value: { douyin: { loggedIn: true } } })
  await account.getByRole('button', { name: '退出', exact: true }).click()
  await expect(cancelLogout).toBeFocused()
  await cancelLogout.click()
  await expect(confirmLogout).toBeHidden()
  await expect(settings).toBeVisible()
  expect(await invoke(page, 'loginStatus', undefined)).toMatchObject({ ok: true, value: { douyin: { loggedIn: true } } })
  await account.getByRole('button', { name: '退出', exact: true }).click()
  await expect(cancelLogout).toBeFocused()
  await confirmLogout.click()
  await expect(settings).toBeVisible()
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

test('抖音HTTP卡片只提交一次合成短信和密码操作, 额外验证提示在App完成', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture('challenge'))
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  await settings.getByRole('region', { name: '抖音', exact: true }).getByRole('button', { name: '登录', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '抖音登录', exact: true })
  const card = await cardPage(electronApp)
  await card.getByRole('tab', { name: '短信登录', exact: true }).click()
  await card.locator('#phone').fill('13800000000')
  await expect(card.getByRole('checkbox')).toHaveCount(0)
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
  }).toBe('form')
  await expect(card.locator('#message').filter({ hasText: /抖音App完成验证/ })).toBeVisible()
  const counts = await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState())
  expect(counts).toMatchObject({ submitted: 1, smsSent: 1 })
  const publicState = await invoke(page, 'getEmbeddedLogin', undefined)
  expect(JSON.stringify(publicState)).not.toMatch(/13800000000|synthetic-password-only|data:image/)
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(false)
  await overlay.getByRole('button', { name: '关闭抖音登录', exact: true }).click()
  await expect(overlay).toBeHidden()
})

test('抖音HTTP登录在App验证完成后核对身份, 期间不会自动发送短信', async ({ page, electronApp }) => {
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
  await expect(local.getByRole('checkbox')).toHaveCount(0)
  await local.getByRole('button', { name: '登录', exact: true }).click()
  await expect(local.locator('#message').filter({ hasText: /抖音App完成验证/ })).toBeVisible()
  expect(electronApp.context().pages().some(value => /^https:\/\/(?:live|login|www)\.douyin\.com\//.test(value.url()))).toBe(false)
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.completeDouyinEmbeddedLoginFixture(true))
  await page.waitForTimeout(1000)
  await expect(overlay).toBeVisible()
  const pending = await invoke(page, 'loginStatus', undefined)
  expect(pending.ok && pending.value.douyin.loggedIn).toBe(false)
  const counts = await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState())
  expect(counts).toMatchObject({ submitted: 1, smsSent: 0 })
  await expect(overlay).toBeHidden()
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(true)
})

test('抖音HTTP登录显示平台拒绝码, 错误正文与详情一致且不会自动重交密码', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture('password-error'))
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  const account = settings.getByRole('region', { name: '抖音', exact: true })
  await account.getByRole('button', { name: '登录', exact: true }).click()
  const card = await cardPage(electronApp)
  await card.getByLabel('账号', { exact: true }).fill('13800000000')
  await card.getByLabel('密码', { exact: true }).fill('synthetic-password-only')
  await card.getByRole('button', { name: '登录', exact: true }).click()
  await expect(card.locator('#message')).toContainText('平台码 1101')
  await expect(card.locator('#message')).not.toContainText('检查网络')
  await expect(card.locator('#password')).toHaveValue('')
  await card.getByRole('button', { name: '查看原始错误', exact: true }).click()
  const detail = card.getByRole('region', { name: '原始错误信息', exact: true })
  await expect(detail).toContainText('"requestStage": "password-login"')
  await expect(detail).toContainText('"platformCode": 1101')
  await expect(detail).not.toContainText('synthetic-password-only')
  await expect(detail).not.toContainText('13800000000')
  await card.waitForTimeout(6000)
  await expect(card.locator('#message')).toContainText('平台码 1101')
  expect(await electronApp.evaluate(() => (globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState().submitted)).toBe(1)
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(false)
  await page.getByRole('button', { name: '关闭抖音登录', exact: true }).click()
})

test('抖音二维码到期自动局部换码, 保留短信输入和焦点且不显示到期提醒', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => {
    const clock=globalThis as typeof globalThis & {__qrClockOffset?:number}
    const original=Date.now.bind(Date)
    clock.__qrClockOffset=0
    Date.now=()=>original()+(clock.__qrClockOffset??0)
    ;(globalThis as FixtureRuntime).__streamSyncerTest.setDouyinEmbeddedLoginFixture()
  })
  await openPlayer(page)
  const settings=await openSettings(page,'抖音')
  await settings.getByRole('region',{name:'抖音',exact:true}).getByRole('button',{name:'登录',exact:true}).click()
  const card=await cardPage(electronApp)
  await card.getByRole('tab',{name:'短信登录',exact:true}).click()
  await card.locator('#phone').fill('13800000000')
  await card.locator('#sms-code').fill('123456')
  await card.evaluate(()=>{
    const state=window as unknown as {__qrForm:Element|null;__qrChanges:Array<{stage:string;status:string;mode:string;expiredMessage:boolean}>}
    state.__qrForm=document.getElementById('login-form')
    state.__qrChanges=[]
    window.loginCard!.subscribe(value=>state.__qrChanges.push({stage:value.stage,status:value.qr.status,mode:value.mode,expiredMessage:!!value.message?.includes('二维码已过期')}))
  })
  await electronApp.evaluate(()=>{(globalThis as typeof globalThis & {__qrClockOffset:number}).__qrClockOffset=60_000})
  await expect.poll(()=>card.evaluate(()=>{
    const changes=(window as unknown as {__qrChanges:Array<{status:string}>}).__qrChanges
    return changes.some(value=>value.status==='loading')&&changes.at(-1)?.status==='ready'
  })).toBe(true)
  await expect(card.locator('#card')).toHaveAttribute('data-stage','form')
  await expect(card.locator('#phone')).toHaveValue('13800000000')
  await expect(card.locator('#sms-code')).toHaveValue('123456')
  await expect(card.getByRole('tab',{name:'短信登录',exact:true})).toHaveAttribute('aria-selected','true')
  const retained=await card.evaluate(()=>{
    const state=window as unknown as {__qrForm:Element|null;__qrChanges:Array<{stage:string;mode:string;expiredMessage:boolean}>}
    return {sameForm:state.__qrForm===document.getElementById('login-form'),focus:document.activeElement?.id,
      allForm:state.__qrChanges.every(value=>value.stage==='form'&&value.mode==='sms'),expiryAlert:state.__qrChanges.some(value=>value.expiredMessage)}
  })
  expect(retained).toEqual({sameForm:true,focus:'sms-code',allForm:true,expiryAlert:false})
  const calls=await electronApp.evaluate(()=>(globalThis as FixtureRuntime).__streamSyncerTest.getDouyinEmbeddedLoginFixtureState())
  expect(calls).toMatchObject({submitted:0,smsSent:0})
  await page.getByRole('button',{name:'关闭抖音登录',exact:true}).click()
})
