import { test, expect, launchApplication } from './electron'
import { openSettings } from './helpers'

async function enable(application: import('@playwright/test').ElectronApplication,
  scenario: 'accounts' | 'mixed' | 'locked' | 'close-failed' | 'uac-cancelled' | 'no-profiles' = 'accounts') {
  await application.evaluate((_electron, value) => {
    ;(globalThis as typeof globalThis & { __streamSyncerTest: { setBrowserImportFixture(value: string): void } }).__streamSyncerTest.setBrowserImportFixture(value)
  }, scenario)
}
async function accounts(page: import('@playwright/test').Page) {
  return openSettings(page, '斗鱼')
}

test('bulk browser import previews names and avatars, imports selected accounts and persists across reopen', async ({ page, electronApp }) => {
  await enable(electronApp)
  const settings = await accounts(page)
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量导入账号', exact: true })
  await expect(dialog.getByLabel('浏览器', { exact: true })).toHaveValue('Microsoft Edge')
  await dialog.getByLabel('浏览器', { exact: true }).selectOption('Google Chrome')
  await expect(dialog.getByLabel('浏览器用户', { exact: true })).toContainText('工作')
  await dialog.getByLabel('浏览器', { exact: true }).selectOption('Mozilla Firefox')
  await expect(dialog.getByLabel('浏览器用户', { exact: true })).toContainText('default')
  await dialog.getByLabel('浏览器', { exact: true }).selectOption('Microsoft Edge')
  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByText('测试斗鱼账号', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('img', { name: '测试哔哩哔哩账号的头像' })).toBeVisible()
  await expect(dialog.getByLabel('导入YouTube', { exact: true })).toBeChecked()
  await dialog.getByLabel('导入YouTube', { exact: true }).uncheck()
  await dialog.getByLabel('导入抖音', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: '导入所选账号（3）', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible()
  const status = await page.evaluate(async () => window.streamSyncer!.invoke('loginStatus', undefined))
  expect(status).toMatchObject({ ok: true, value: { douyu: { loggedIn: true, nickname: '测试斗鱼账号' },
    bilibili: { loggedIn: true, nickname: '测试哔哩哔哩账号' }, huya: { loggedIn: true }, youtube: { loggedIn: false }, douyin: { loggedIn: false } } })
  expect(JSON.stringify(status)).not.toContain('synthetic-session')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expect(settings.getByText('测试斗鱼账号', { exact: true })).toBeVisible()
  await settings.getByRole('tab', { name: '哔哩哔哩', exact: true }).click()
  await expect(settings.getByRole('button', { name: '从浏览器导入', exact: true })).toBeVisible()
  await expect(settings.getByRole('button', { name: '批量导入账号', exact: true })).toBeVisible()
  await expect(settings.locator('.account-identity')).toContainText('测试哔哩哔哩账号')
})

test('each platform opens a scoped import and unavailable accounts cannot be imported', async ({ page, electronApp }) => {
  await enable(electronApp, 'mixed')
  const settings = await accounts(page)
  for (const platform of ['哔哩哔哩', '虎牙', '抖音', 'YouTube']) {
    await settings.getByRole('tab', { name: platform, exact: true }).click()
    await settings.getByRole('button', { name: '从浏览器导入', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `从浏览器导入 ${platform} 账号`, exact: true })
    await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
    await expect(dialog.locator('.browser-import-account')).toHaveCount(1)
    if (platform === '虎牙' || platform === '抖音') await expect(dialog.getByRole('button', { name: '导入账号', exact: true })).toBeDisabled()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
  }
  const status = await page.evaluate(async () => window.streamSyncer!.invoke('loginStatus', undefined))
  expect(status).toMatchObject({ ok: true, value: { bilibili: { loggedIn: false }, huya: { loggedIn: false }, douyin: { loggedIn: false }, youtube: { loggedIn: false } } })
})

test('locked browser and cancelled Windows authorization retain the original login and allow retry', async ({ page, electronApp }) => {
  await enable(electronApp, 'locked')
  const settings = await accounts(page)
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '批量导入账号', exact: true })
  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('完全关闭')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await enable(electronApp, 'uac-cancelled')
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '批量导入账号', exact: true })
  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('授权已取消')
  await expect(dialog.getByRole('button', { name: '导入所选账号（0）', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
})

test('one-click browser close requires secondary confirmation and unlocks a locked browser for retry', async ({ page, electronApp }) => {
  await enable(electronApp, 'locked')
  const settings = await accounts(page)
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量导入账号', exact: true })
  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('正在使用中')

  await dialog.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  const confirmBox = dialog.getByRole('alertdialog', { name: '确认关闭 Microsoft Edge', exact: true })
  await expect(confirmBox).toBeVisible()
  await confirmBox.getByRole('button', { name: '暂不关闭', exact: true }).click()
  await expect(confirmBox).not.toBeVisible()

  await dialog.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await expect(confirmBox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirmBox).not.toBeVisible()
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await confirmBox.getByRole('button', { name: '确认关闭', exact: true }).click()
  await expect(dialog.getByText('已关闭 Microsoft Edge，现在可以点击「识别账号」继续', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)

  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByText('测试斗鱼账号', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await enable(electronApp, 'close-failed')
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  await dialog.getByRole('button', { name: '关闭浏览器', exact: true }).click()
  await dialog.getByRole('button', { name: '确认关闭', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('未能完全关闭对应浏览器')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
})

test('Escape closes only the import dialog and releases its preview', async ({ page, electronApp }) => {
  await enable(electronApp)
  const settings = await accounts(page)
  await settings.getByRole('button', { name: '批量导入账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '批量导入账号', exact: true })
  await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
  await expect(dialog.getByText('测试斗鱼账号', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: '从浏览器导入', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '从浏览器导入 斗鱼 账号', exact: true })).toBeVisible()
})

test('imported account identity survives an application restart', async () => {
  const running = await launchApplication('browser-import-restart')
  try {
    await enable(running.application)
    let settings = await openSettings(running.page, '哔哩哔哩')
    await settings.getByRole('button', { name: '从浏览器导入', exact: true }).click()
    const dialog = running.page.getByRole('dialog', { name: '从浏览器导入 哔哩哔哩 账号', exact: true })
    await dialog.getByRole('button', { name: '识别账号', exact: true }).click()
    await dialog.getByRole('button', { name: '导入账号', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '完成', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await running.restart()
    settings = await openSettings(running.page, '哔哩哔哩')
    await expect(settings.locator('.account-identity')).toContainText('测试哔哩哔哩账号')
    await expect(settings.getByRole('img', { name: '测试哔哩哔哩账号的头像' })).toBeVisible()
    await expect(settings.getByRole('button', { name: '重新登录', exact: true })).toBeVisible()
  } finally { await running.close() }
})
