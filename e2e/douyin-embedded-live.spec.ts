import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from './electron'
import { invoke, openPlayer, openSettings } from './helpers'

test('抖音真实内嵌登录页显示官方二维码和表单, 取消后清理视图', async ({ page, electronApp }) => {
  test.skip(process.env.STREAM_SYNC_DOUYIN_LOGIN_LIVE !== '1' || process.env.STREAM_SYNC_LIVE_TESTS !== '1',
    '需要显式开启公开匿名登录页验证, 不提交账号或短信.')
  test.setTimeout(120_000)
  await openPlayer(page)
  const settings = await openSettings(page, '抖音')
  await settings.getByRole('region', { name: '抖音', exact: true }).getByRole('button', { name: '登录', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '抖音登录', exact: true })
  await expect(overlay).toBeVisible()
  await expect.poll(() => electronApp.context().pages().some(value => value.url().startsWith('app://login/'))).toBe(true)
  const local = electronApp.context().pages().find(value => value.url().startsWith('app://login/'))!
  await expect(local.locator('#card')).toHaveAttribute('data-stage', 'form', { timeout: 80_000 })
  await expect(local.locator('#qr-image')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => local.locator('#qr-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth >= 64)).toBe(true)
  await expect(local.getByRole('tab', { name: '短信登录', exact: true })).toBeVisible()
  await expect(local.getByRole('tab', { name: '密码登录', exact: true })).toBeVisible()
  await local.getByRole('tab', { name: '密码登录', exact: true }).click()
  await expect(local.getByLabel('密码', { exact: true })).toBeVisible()
  await local.getByRole('tab', { name: '短信登录', exact: true }).click()
  await expect(local.locator('#sms-code')).toBeVisible()
  await expect(local.locator('#sms-code')).toBeEnabled()
  const image = await electronApp.evaluate(async ({ webContents, BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().length !== 1) throw new Error('The login opened another OS window')
    const contents = webContents.getAllWebContents().find(value => value.getURL().startsWith('app://login/'))
    if (!contents) throw new Error('The local login card is missing')
    return (await contents.capturePage()).toPNG().toString('base64')
  })
  await mkdir(test.info().outputDir, { recursive: true })
  await writeFile(test.info().outputPath('douyin-official-login-card.png'), Buffer.from(image, 'base64'))
  const status = await invoke(page, 'loginStatus', undefined)
  expect(status.ok && status.value.douyin.loggedIn).toBe(false)
  await overlay.getByRole('button', { name: '关闭抖音登录', exact: true }).click()
  await expect(overlay).toBeHidden()
  await expect.poll(() => electronApp.context().pages().filter(value => value.url().startsWith('app://login/')).length).toBe(0)
})
