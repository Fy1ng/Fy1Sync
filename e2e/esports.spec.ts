import { test, expect } from './electron'
import fixture from '../server/esports/fixtures/liquipedia-matches.json' with { type: 'json' }

test('赛程和直播标题只读接口通过真实 IPC 读取离线缓存并校验参数', async ({ electronApp, page }) => {
  await electronApp.evaluate(async ({ app }, payload) => {
    const { mkdir, writeFile } = process.getBuiltinModule('node:fs/promises')
    const { join } = process.getBuiltinModule('node:path')
    const directory = join(app.getPath('userData'), 'events')
    await mkdir(directory, { recursive: true })
    const delta = Math.floor(Date.now() / 1000) - 1793032200
    const html = payload.parse.text['*'].replace(/data-timestamp="(\d+)"/g, (_all, seconds: string) => `data-timestamp="${Number(seconds) + delta}"`)
    await writeFile(join(directory, 'liquipedia.json'), JSON.stringify({ schema: 1, fetchedAt: Date.now(), payload: { parse: { text: { '*': html } } } }))
  }, fixture)
  const result = await page.evaluate(async () => {
    const api = window.streamSyncer!
    const schedule = await api.invoke('getCs2Schedule', undefined)
    const titles = await api.invoke('getStreamTitles', { streams: [{ platform: 'youtube', channel: 'PGL', videoId: null }] })
    const bad = await api.invoke('getStreamTitles', { streams: [{ platform: 'youtube', channel: '../../private', videoId: null }] })
    return { schedule, titles, bad }
  })
  expect(result.schedule).toMatchObject({ ok: true, value: { source: 'liquipedia', stale: false, attribution: '赛程数据来自 Liquipedia (CC-BY-SA 3.0)' } })
  if (!result.schedule.ok) throw new Error('Schedule IPC failed')
  expect(result.schedule.value.matches[0]).toMatchObject({ state: 'live', teams: [{ name: 'G2 Esports' }, { name: 'DENDELE CS' }] })
  expect(result.titles).toMatchObject({ ok: true, value: [{ title: null, stage: null, live: null }] })
  expect(result.bad).toMatchObject({ ok: false, code: 'invalid-arguments' })
})

test('赛程页按赛事列出对阵, 点击直播流即关闭并在背后的画面位载入, 失败时在那里说明', async ({ electronApp, page }) => {
  await electronApp.evaluate(async ({ app }, payload) => {
    const { mkdir, writeFile } = process.getBuiltinModule('node:fs/promises')
    const { join } = process.getBuiltinModule('node:path')
    const directory = join(app.getPath('userData'), 'events')
    await mkdir(directory, { recursive: true })
    const delta = Math.floor(Date.now() / 1000) - 1793032200
    const html = payload.parse.text['*'].replace(/data-timestamp="(\d+)"/g, (_all, seconds: string) => `data-timestamp="${Number(seconds) + delta}"`)
    await writeFile(join(directory, 'liquipedia.json'), JSON.stringify({ schema: 1, fetchedAt: Date.now(), payload: { parse: { text: { '*': html } } } }))
  }, fixture)
  await page.goto('app://app/')
  const intake = page.getByRole('dialog', { name: '添加直播间' })
  await expect(intake).toBeVisible()
  // The studio read the schedule at start-up, so the sheet's first frame already lists events.
  await page.waitForTimeout(500)
  const firstFrame = await page.evaluate(async () => {
    const open = [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('CS2 赛程'))
    open!.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return document.querySelector('[role="dialog"][aria-label="赛程"]')?.textContent ?? ''
  })
  expect(firstFrame).toContain('PGL Masters Bucharest 2026')
  expect(firstFrame).not.toContain('正在读取赛程')
  // 赛程 opens over 添加直播间, which stays behind it.
  await expect(intake).toBeVisible()

  const sheet = page.getByRole('dialog', { name: '赛程', exact: true })
  await expect(sheet).toBeVisible()
  // The event with matches on now leads; both of its live matches are listed under 进行中.
  const events = sheet.getByRole('tablist', { name: '赛事' })
  await expect(events.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await expect(events.getByRole('tab').first()).toContainText('PGL Masters Bucharest 2026')
  const live = sheet.getByRole('region', { name: '进行中' })
  await expect(live.getByRole('listitem', { name: 'G2 Esports 对 DENDELE CS' })).toBeVisible()
  await expect(live.getByRole('listitem', { name: 'BetBoom Team 对 Natus Vincere' })).toBeVisible()
  await expect(sheet).toContainText('赛程数据来自 Liquipedia (CC-BY-SA 3.0)')

  // Offline E2E refuses real platform acquisition, which stands in for a stream that will not play.
  const match = live.getByRole('listitem', { name: 'G2 Esports 对 DENDELE CS' })
  await match.getByRole('button', { name: /^在YouTube观看 G2 Esports 对 DENDELE CS/ }).click()
  // The pick closes the sheet at once and the load, here failing, shows on the 画面 slot behind.
  await expect(sheet).toBeHidden()
  await expect(intake).toBeVisible()
  await expect(intake.locator('.slot[data-role="official"] .slot-error')).toBeVisible()
  await expect(page.locator('.chip[data-role="official"]')).toHaveAttribute('data-status', 'empty')

  // Closing without a pick goes back to 添加直播间 as well.
  await intake.getByRole('button', { name: /^CS2 赛程/ }).click()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(intake).toBeVisible()
  await intake.getByRole('button', { name: /^CS2 赛程/ }).click()
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(intake).toBeVisible()
})
