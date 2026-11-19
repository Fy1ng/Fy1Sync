import { expect, launchApplication, test } from './electron'
import { openSettings } from './helpers'

test('取流网络默认开放, 可配置并在重启后保留', async () => {
  const running = await launchApplication('network-freedom')
  try {
    const settings = await openSettings(running.page, '网络')
    await expect(settings.getByRole('combobox', { name: '取流连接方式' })).toBeEnabled()
    await expect(settings.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
    await expect(settings.getByRole('switch', { name: '校验取流服务器证书' })).not.toBeChecked()
    await expect(settings.getByRole('switch', { name: '校验 HTTPS 代理证书' })).not.toBeChecked()
    await expect(settings.getByRole('switch', { name: '允许媒体访问本机和局域网' })).toBeChecked()
    await expect(settings.getByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue('0')
    await settings.getByRole('switch', { name: /^国内平台直接连接/ }).locator('..').click()
    await expect.poll(async () => running.page.evaluate(async () => {
      const state = await window.streamSyncer!.invoke('getNetworkPreferences', undefined)
      return state.ok ? state.value.domesticRouting : null
    })).toBe('direct')
    await settings.getByRole('combobox', { name: '取流连接方式' }).selectOption('custom')
    await settings.getByRole('textbox', { name: '取流代理地址' }).fill('http://127.0.0.1:17890')
    await settings.getByText('校验取流服务器证书', { exact: true }).click()
    await expect(settings.getByRole('switch', { name: '校验取流服务器证书' })).toBeChecked()
    await settings.getByRole('spinbutton', { name: '请求超时秒数' }).fill('30')
    await settings.getByRole('spinbutton', { name: '重定向次数' }).fill('12')
    await settings.getByRole('spinbutton', { name: '同屏直播数量上限' }).fill('300')
    await settings.getByRole('textbox', { name: '来源地址' }).fill('https://media.invalid:8443/live')
    await settings.getByRole('textbox', { name: '来源请求头' }).fill('Authorization: Bearer synthetic-test-only')
    await settings.getByText('校验该来源服务器证书', { exact: true }).click()
    await settings.getByRole('button', { name: '保存取流网络设置' }).click()
    await expect(settings.getByText('网络设置已保存', { exact: true })).toBeVisible()
    await expect.poll(async () => running.page.evaluate(async () => {
      const state = await window.streamSyncer!.invoke('getNetworkPreferences', undefined)
      return state.ok ? state.value.media : null
    })).toMatchObject({ routing: 'custom', proxyUrl: 'http://127.0.0.1:17890', verifyTls: true, verifyProxyTls: false,
      allowPrivate: true, requestTimeoutMs: 30000, maxRedirects: 12, maxExtraStreams: 300,
      sourceRules: [{ origin: 'https://media.invalid:8443', headers: { Authorization: 'Bearer synthetic-test-only' }, verifyTls: false, verifyProxyTls: true }] })
    await running.restart()
    const restored = await openSettings(running.page, '网络')
    await expect(restored.getByRole('combobox', { name: '取流连接方式' })).toBeEnabled()
    await expect(restored.getByRole('button', { name: '保存取流网络设置' })).toBeDisabled()
    await expect(restored.getByRole('switch', { name: /^国内平台直接连接/ })).not.toBeChecked()
    await expect(restored.getByRole('combobox', { name: '取流连接方式' })).toHaveValue('custom')
    await expect(restored.getByRole('textbox', { name: '取流代理地址' })).toHaveValue('http://127.0.0.1:17890')
    await expect(restored.getByRole('switch', { name: '校验取流服务器证书' })).toBeChecked()
    await expect(restored.getByRole('spinbutton', { name: '请求超时秒数' })).toHaveValue('30')
    await expect(restored.getByRole('spinbutton', { name: '重定向次数' })).toHaveValue('12')
    await expect(restored.getByRole('spinbutton', { name: '同屏直播数量上限' })).toHaveValue('300')
    await expect(restored.getByRole('button', { name: '编辑来源 https://media.invalid:8443' })).toBeVisible()
    await expect(restored.getByText('Bearer synthetic-test-only', { exact: true })).toHaveCount(0)
    await running.page.screenshot({ path: '.runtime-cache/media-network-settings.png' })
    await restored.getByRole('button', { name: '保存取流网络设置' }).scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: '.runtime-cache/media-source-rules.png' })
  } finally { await running.close() }
})

test('网络草稿在 Esc、背景关闭和切页时先确认，非法来源保留编辑内容', async () => {
  const running = await launchApplication('network-draft-leaving')
  try {
    const settings = await openSettings(running.page, '网络')
    const origin = settings.getByRole('textbox', { name: '来源地址' })
    await origin.fill('invalid-source')
    await origin.press('Escape')
    const confirm = settings.getByRole('alertdialog', { name: '未保存的网络设置' })
    await expect(confirm).toBeVisible()
    await expect(settings).toBeVisible()
    await confirm.getByRole('button', { name: '继续编辑' }).click()
    await expect(origin).toHaveValue('invalid-source')
    await running.page.mouse.click(1, 1)
    await expect(confirm).toBeVisible()
    await expect(settings).toBeVisible()
    await confirm.getByRole('button', { name: '保存', exact: true }).click()
    await expect(confirm).not.toBeVisible()
    await expect(settings.getByRole('alert')).toContainText('请输入有效的 HTTP/HTTPS 来源')
    await expect(origin).toHaveValue('invalid-source')
    await origin.fill('https://media.invalid/live')
    await settings.getByRole('tablist', { name: '通用', exact: true }).getByRole('tab', { name: '解码', exact: true }).click()
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '保存', exact: true }).click()
    await expect(settings.getByRole('tabpanel', { name: '解码', exact: true })).toBeVisible()
    await settings.getByRole('tablist', { name: '通用', exact: true }).getByRole('tab', { name: '网络', exact: true }).click()
    await expect(settings.getByRole('button', { name: '编辑来源 https://media.invalid' })).toBeVisible()
    await settings.getByRole('switch', { name: /^国内平台直接连接/ }).locator('..').click()
    await settings.getByRole('tablist', { name: '设置分区' }).getByRole('tab', { name: '画面匹配', exact: true }).click()
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '放弃', exact: true }).click()
    await expect(settings.getByRole('tabpanel', { name: '画面匹配', exact: true })).toBeVisible()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(settings).not.toBeVisible()
  } finally { await running.close() }
})

test('普通外链和新窗口交给浏览器, 应用页面保留原有权限边界', async () => {
  const running = await launchApplication('external-navigation')
  try {
    await running.application.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { __externalNavigationCalls?: string[] }
      state.__externalNavigationCalls = []
      shell.openExternal = async url => { state.__externalNavigationCalls!.push(url) }
    })
    await running.page.evaluate(() => {
      const link = document.createElement('a')
      link.href = 'https://external.invalid:8443/user-selected'
      link.textContent = 'external test link'
      document.body.append(link)
      link.click()
      link.remove()
      window.open('http://127.0.0.1:9210/user-selected', '_blank')
    })
    await expect.poll(() => running.application.evaluate(() =>
      (globalThis as typeof globalThis & { __externalNavigationCalls?: string[] }).__externalNavigationCalls?.toSorted(),
    )).toEqual(['https://external.invalid:8443/user-selected', 'http://127.0.0.1:9210/user-selected'].sort())
    expect(running.page.url()).toMatch(/^app:\/\/app\//)
    expect(running.application.windows()).toHaveLength(1)
  } finally { await running.close() }
})
