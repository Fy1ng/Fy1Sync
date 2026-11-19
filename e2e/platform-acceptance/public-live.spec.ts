import { test, expect, type Page } from '@playwright/test'
import { launchApplication } from '../electron'
import { loadSource, openPlayer, setPlaying } from '../helpers'

const platforms = [
  { name: '斗鱼', variable: 'STREAM_SYNC_DOUYU_LIVE_URL', role: 'commentary' },
  { name: '哔哩哔哩', variable: 'STREAM_SYNC_BILIBILI_LIVE_URL', role: 'commentary' },
  { name: '抖音', variable: 'STREAM_SYNC_DOUYIN_LIVE_URL', role: 'commentary' },
  { name: '虎牙', variable: 'STREAM_SYNC_HUYA_LIVE_URL', role: 'commentary' },
  { name: 'YouTube', variable: 'STREAM_SYNC_YOUTUBE_LIVE_URL', role: 'official' },
  { name: 'Twitch', variable: 'STREAM_SYNC_TWITCH_LIVE_URL', role: 'official' },
] as const

async function expectPlayback(page: Page, role: 'official' | 'commentary'): Promise<void> {
  const video = page.locator(`video.media-element[data-role="${role}"]`)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(before + 1)
}

test.describe('匿名平台直播 UI', () => {
  test.skip(process.env.STREAM_SYNC_P07_PUBLIC_LIVE !== '1', '真实网络烟测需显式启用 STREAM_SYNC_P07_PUBLIC_LIVE=1')
  test.describe.configure({ timeout: 270_000 })

  for (const { name, variable, role } of platforms) {
    test(`${name}从普通入口载入并实际播放`, async () => {
      const url = process.env[variable]
      test.skip(!url, `缺少公开在播房间 ${variable}`)
      if (!url) return
      const app = await launchApplication(`p07-public-${name}`, { liveNetwork: true })
      try {
        await openPlayer(app.page)
        await loadSource(app.page, role, url, 90_000)
        await setPlaying(app.page, true)
        await expectPlayback(app.page, role)
        await setPlaying(app.page, false)
      } finally {
        await app.close()
      }
    })
  }

  for (const pair of [
    { name: '同平台不同房', official: 'STREAM_SYNC_DOUYU_LIVE_URL', commentary: 'STREAM_SYNC_P07_DOUYU_SECOND_URL' },
    { name: '跨平台双路', official: 'STREAM_SYNC_TWITCH_LIVE_URL', commentary: 'STREAM_SYNC_DOUYU_LIVE_URL' },
  ]) {
    test(`${pair.name}的两个可见播放器同时前进`, async () => {
      const official = process.env[pair.official]
      const commentary = process.env[pair.commentary]
      test.skip(!official || !commentary, `需配置 ${pair.official} 和 ${pair.commentary}`)
      if (!official || !commentary) return
      expect(official).not.toBe(commentary)
      const app = await launchApplication(`p07-public-${pair.name}`, { liveNetwork: true })
      try {
        await openPlayer(app.page)
        await loadSource(app.page, 'official', official, 90_000)
        await loadSource(app.page, 'commentary', commentary, 90_000)
        await setPlaying(app.page, true)
        await Promise.all([expectPlayback(app.page, 'official'), expectPlayback(app.page, 'commentary')])
        await setPlaying(app.page, false)
      } finally {
        await app.close()
      }
    })
  }
})
