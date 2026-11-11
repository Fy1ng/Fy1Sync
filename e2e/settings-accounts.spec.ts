import { mkdir } from 'node:fs/promises'
import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { openDouyuTab, openPlayer, openSettings, openSettingsSection } from './helpers'

test('账号分区将五平台及斗鱼子页放在同一侧栏并记住选择', async ({}, testInfo) => {
  const running = await launchApplication('settings-accounts')
  try {
    await running.application.evaluate(() => {
      if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Account navigation requires a disposable offline profile')
    })
    await openPlayer(running.page)
    const general = await openSettings(running.page, '对齐')
    const sections = general.getByRole('tablist', { name: '设置分区', exact: true })
    await expect(sections.getByRole('tab')).toHaveText(['通用', '账号', '弹幕记录', '房间数据', '倒计时样式'])
    for (const name of ['斗鱼', '哔哩哔哩', '虎牙', '抖音', 'YouTube']) {
      await expect(general.getByRole('tablist', { name: '通用', exact: true }).getByRole('tab', { name, exact: true })).toHaveCount(0)
    }
    const settings = await openDouyuTab(running.page, '账号')
    const platforms = settings.getByRole('tablist', { name: '账号平台', exact: true })
    for (const name of ['斗鱼', '哔哩哔哩', '虎牙', '抖音', 'YouTube']) await expect(platforms.getByRole('tab', { name, exact: true })).toBeVisible()
    const nested = settings.getByRole('tablist', { name: '斗鱼', exact: true })
    await expect(nested.getByRole('tab')).toHaveText(['账号', '关注', '背包', '实验性'])
    expect(await platforms.evaluate(node => {
      const sidebar = node.closest('.side-nav')
      const subnav = node.closest('.settings')?.querySelector('[role="tablist"][aria-label="斗鱼"]')
      return !!sidebar && subnav?.closest('.side-nav') === sidebar
    })).toBe(true)
    await expect(settings.locator('.side-nav')).toHaveCount(1)
    await mkdir(testInfo.outputDir, { recursive: true })
    await running.page.screenshot({ path: testInfo.outputPath('accounts-douyu-navigation.png'), fullPage: true, animations: 'disabled' })
    await openDouyuTab(running.page, '实验性')
    await openSettings(running.page, '哔哩哔哩')
    await expect(nested).toHaveCount(0)
    await expect(settings.getByRole('region', { name: '哔哩哔哩账号', exact: true })).toBeVisible()
    await openSettings(running.page, '虎牙')
    await expect(settings.getByRole('region', { name: '虎牙账号', exact: true })).toBeVisible()
    await openSettings(running.page)
    await expect(platforms.getByRole('tab', { name: 'YouTube', exact: true })).toHaveAttribute('aria-selected', 'true')
    await openSettings(running.page, '斗鱼')
    await expect(nested.getByRole('tab', { name: '实验性', exact: true })).toHaveAttribute('aria-selected', 'true')
    await openSettings(running.page, '虎牙')
    await running.page.screenshot({ path: testInfo.outputPath('accounts-huya-navigation.png'), fullPage: true, animations: 'disabled' })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    // Reopen the saved section without requesting a platform through the helper.
    await running.page.getByRole('button', { name: '设置', exact: true }).first().click()
    await expect(settings).toBeVisible()
    await expect(sections.getByRole('tab', { name: '账号', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(platforms.getByRole('tab', { name: '虎牙', exact: true })).toHaveAttribute('aria-selected', 'true')
    await openSettingsSection(running.page, '通用')
    await expect(settings.getByRole('tablist', { name: '通用', exact: true }).getByRole('tab', { name: '对齐', exact: true })).toHaveAttribute('aria-selected', 'true')
  } finally { await running.close() }
})
