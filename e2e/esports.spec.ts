import { test, expect } from './electron'
import type { ElectronApplication } from '@playwright/test'

async function installOfflineScheduleFixture(electronApp: ElectronApplication) {
  await electronApp.evaluate(async ({ app }) => {
    const { mkdir, writeFile } = process.getBuiltinModule('node:fs/promises')
    const { join } = process.getBuiltinModule('node:path')
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Offline E2E profile required')
    const now = Date.now()
    const payload = {
      schema: 1,
      fetchedAt: now,
      generatedAt: now,
      source: 'liquipedia',
      attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）',
      upstream: { limitedUntil: null },
      matches: [
        {
          id: 'pgl-live-1',
          startsAt: now - 600_000,
          state: 'live',
          teams: [
            { name: 'G2 Esports', short: 'G2', logo: null },
            { name: 'DENDELE CS', short: 'DENDELE', logo: null },
          ],
          score: [0, 1],
          bestOf: 3,
          tournament: {
            name: 'PGL Masters Bucharest 2026',
            stage: 'Round 3',
            tier: 1,
            url: 'https://liquipedia.net/counterstrike/PGL/2026/Masters#Round_3',
            logo: null,
          },
          streams: [
            { platform: 'twitch', entry: 'PGL_CS2', channel: 'pgl_cs2', videoId: null, missing: null },
            { platform: 'youtube', entry: 'PGL', channel: null, videoId: 'sx5tneE-ILg', missing: null },
          ],
        },
        {
          id: 'pgl-live-2',
          startsAt: now - 300_000,
          state: 'live',
          teams: [
            { name: 'BetBoom Team', short: 'BB', logo: null },
            { name: 'Natus Vincere', short: 'NAVI', logo: null },
          ],
          score: [1, 0],
          bestOf: 3,
          tournament: {
            name: 'PGL Masters Bucharest 2026',
            stage: 'Round 3',
            tier: 1,
            url: 'https://liquipedia.net/counterstrike/PGL/2026/Masters#Round_3',
            logo: null,
          },
          streams: [
            { platform: 'youtube', entry: 'PGL', channel: null, videoId: 'ZTdOeOvsv2E', missing: null },
          ],
        },
        {
          id: 'iem-upcoming-1',
          startsAt: now + 3_600_000,
          state: 'upcoming',
          teams: [
            { name: 'Team Spirit', short: 'Spirit', logo: null },
            { name: 'MOUZ', short: 'MOUZ', logo: null },
          ],
          score: null,
          bestOf: 3,
          tournament: {
            name: 'IEM Beijing 2026',
            stage: 'Playoffs',
            tier: 1,
            url: 'https://liquipedia.net/counterstrike/Intel_Extreme_Masters/2026/Beijing#Playoffs',
            logo: null,
          },
          streams: [],
        },
      ],
    }
    const directory = join(app.getPath('userData'), 'events')
    await mkdir(directory, { recursive: true })
    const etag = '"offline-esports-fixture"'
    await writeFile(join(directory, 'relay-schedule.json'), JSON.stringify({
      origin: 'https://schedule.fy1ng.cn',
      receivedAt: now,
      etag,
      schedule: payload,
    }))
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://schedule.fy1ng.cn' && url.pathname === '/v1/cs2/schedule') {
        return Response.json(payload, { headers: { ETag: etag } })
      }
      return original(input, init)
    }
  })
}

test('赛程和直播标题只读接口通过真实 IPC 读取离线缓存并校验参数', async ({ electronApp, page }) => {
  await installOfflineScheduleFixture(electronApp)
  const result = await page.evaluate(async () => {
    const api = window.streamSyncer!
    const schedule = await api.invoke('getCs2Schedule', { refresh: true })
    const titles = await api.invoke('getStreamTitles', { streams: [{ platform: 'youtube', channel: 'PGL', videoId: null }] })
    const bad = await api.invoke('getStreamTitles', { streams: [{ platform: 'youtube', channel: '../../private', videoId: null }] })
    return { schedule, titles, bad }
  })
  expect(result.schedule).toMatchObject({ ok: true, value: { source: 'liquipedia', stale: false, attribution: '赛程数据来自 Liquipedia（CC-BY-SA 3.0）' } })
  if (!result.schedule.ok) throw new Error('Schedule IPC failed')
  expect(result.schedule.value.matches[0]).toMatchObject({ state: 'live', teams: [{ name: 'G2 Esports' }, { name: 'DENDELE CS' }] })
  expect(result.titles).toMatchObject({ ok: true, value: [{ title: null, stage: null, live: null }] })
  expect(result.bad).toMatchObject({ ok: false, code: 'invalid-arguments' })
})

test('赛程页按赛事列出对阵, 点击直播流即关闭并在背后的画面位载入, 失败时在那里说明', async ({ electronApp, page }) => {
  await installOfflineScheduleFixture(electronApp)
  await page.evaluate(() => window.streamSyncer!.invoke('getCs2Schedule', { refresh: true }))
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
  await expect(sheet).toContainText('赛程数据来自 Liquipedia（CC-BY-SA 3.0）')

  // Offline E2E refuses real platform acquisition, which stands in for a stream that will not play.
  const match = live.getByRole('listitem', { name: 'G2 Esports 对 DENDELE CS' })
  await match.getByRole('button', { name: /^在 YouTube 观看 G2 Esports 对 DENDELE CS/ }).click()
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
