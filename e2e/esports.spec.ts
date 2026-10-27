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
