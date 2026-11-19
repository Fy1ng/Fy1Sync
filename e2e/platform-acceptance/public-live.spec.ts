import { test, expect, type Page } from '@playwright/test'
import { launchApplication } from '../electron'
import { openPlayer, openSettingsSection, openSourcePanel, revealOverlay, setPlaying } from '../helpers'

const platforms = [
  { name: '斗鱼', variable: 'STREAM_SYNC_DOUYU_LIVE_URL', role: 'commentary' },
  { name: '哔哩哔哩', variable: 'STREAM_SYNC_BILIBILI_LIVE_URL', role: 'commentary' },
  { name: '抖音', variable: 'STREAM_SYNC_DOUYIN_LIVE_URL', role: 'commentary' },
  { name: '虎牙', variable: 'STREAM_SYNC_HUYA_LIVE_URL', role: 'commentary' },
  { name: 'YouTube', variable: 'STREAM_SYNC_YOUTUBE_LIVE_URL', role: 'official' },
  { name: 'Twitch', variable: 'STREAM_SYNC_TWITCH_LIVE_URL', role: 'official' },
] as const

async function loadPublicSource(page: Page, role: 'official' | 'commentary', url: string): Promise<void> {
  const panel = await openSourcePanel(page, role)
  await panel.getByRole('textbox', { name: role === 'official' ? '画面链接' : '解说链接', exact: true }).fill(url)
  await panel.getByRole('button', { name: '载入', exact: true }).click()
  const failure = panel.locator('.form-error[role="alert"]').first()
  await expect.poll(async () => !(await panel.isVisible()) || await failure.isVisible(), {
    timeout: 90_000, message: '应完成取流或显示片源载入错误',
  }).toBe(true)
  if (await failure.isVisible()) {
    const message = (await failure.innerText()).replace(/https?:\/\/\S+/g, '[链接]').trim().slice(0, 250)
    throw new Error(`片源载入失败: ${message}`)
  }
}

async function expectPlayback(page: Page, role: 'official' | 'commentary'): Promise<void> {
  const video = page.locator(`video.media-element[data-role="${role}"]`)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  const before = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 }).toBeGreaterThan(before + 1)
}

async function expectGuestStatus(page: Page, platform: typeof platforms[number]['name']): Promise<void> {
  const drawer = page.getByRole('complementary', { name: '弹幕', exact: true })
  if (!(await drawer.isVisible())) {
    await revealOverlay(page)
    await page.getByRole('button', { name: '展开弹幕', exact: true }).click()
  }
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: '弹幕内容', exact: true })).toHaveCount(0)
  if (platform === '哔哩哔哩') {
    await drawer.getByText('B 站表情目录', { exact: true }).click()
    await expect(drawer.getByRole('status').filter({ hasText: '请先登录 B 站.' })).toBeVisible()
  }
  if (platform === '抖音') {
    await expect(drawer.getByRole('textbox', { name: '抖音弹幕内容', exact: true })).toBeDisabled()
    await expect(drawer.getByRole('button', { name: '登录抖音', exact: true })).toBeVisible()
  }
  if (platform === 'YouTube' || platform === 'Twitch') {
    await expect(drawer.getByRole('status').filter({
      hasText: platform === 'YouTube' ? /YouTube.*聊天不可用.*读取凭据/ : /Twitch.*聊天不可用.*读取授权/,
    })).toBeVisible()
  }
  const settings = await openSettingsSection(page, '房间数据')
  const expected = {
    斗鱼: [/官方今日观看/, /粉丝牌累计观看/, /未登录/],
    哔哩哔哩: [/全房观看计数/, /本房今日观看时长、累计观看时长和个人看播任务均未知/],
    抖音: [/本房官方今日和累计观看时长未知/, /普通福袋开奖时间是活动信息/],
    虎牙: [/本房观看时长未验证/, /看过 可查询浏览记录/],
    YouTube: [/官方观看历史|观看历史/, /本场视频实际观看的分钟/, /estimatedMinutesWatched/],
    Twitch: [/本频道今日及累计观看/, /频道积分/, /连续观看/, /Drops 进度/, /Drops 权益/, /未核验/],
  } satisfies Record<typeof platform, RegExp[]>
  for (const pattern of expected[platform]) await expect(settings).toContainText(pattern)
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
        await test.step('从可见片源入口载入, 确认播放后暂停', async () => {
          await loadPublicSource(app.page, role, url)
          await setPlaying(app.page, true)
          await expectPlayback(app.page, role)
          await setPlaying(app.page, false)
        })
        if (process.env.STREAM_SYNC_P07_PUBLIC_STATUS === '1') {
          await test.step('核对访客的聊天权限和个人观时降级', () => expectGuestStatus(app.page, name))
        }
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
        await loadPublicSource(app.page, 'official', official)
        await loadPublicSource(app.page, 'commentary', commentary)
        await setPlaying(app.page, true)
        await Promise.all([expectPlayback(app.page, 'official'), expectPlayback(app.page, 'commentary')])
        await setPlaying(app.page, false)
      } finally {
        await app.close()
      }
    })
  }
})
