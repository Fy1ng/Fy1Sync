import { locateTool } from '../electron/toolLocator'
import { expect, test } from './electron'
import { invoke, loadSource, openPlayer, openSourcePanel, revealOverlay, setPlaying } from './helpers'

test.describe('opt-in Douyin playback through the source UI', () => {
  test.skip(process.env.STREAM_SYNC_LIVE_TESTS !== '1' || !process.env.STREAM_SYNC_DOUYIN_LIVE_URL,
    '需显式开启 STREAM_SYNC_LIVE_TESTS=1 并提供当前公开直播间 STREAM_SYNC_DOUYIN_LIVE_URL.')
  test.beforeAll(async () => { await locateTool('ffmpeg'); await locateTool('ffprobe') })

  test('plays real video, changes quality, receives read-only chat and saves the room', async ({ page }) => {
    test.setTimeout(240_000)
    await openPlayer(page)
    await loadSource(page, 'commentary', process.env.STREAM_SYNC_DOUYIN_LIVE_URL!, 100_000)
    const video = page.locator('video[data-role="commentary"]')
    await setPlaying(page, true)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0)
    const firstTime = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 20_000 }).toBeGreaterThan(firstTime + 1)

    const first = await invoke(page, 'getStreamPlayback', { id: 'commentary' })
    expect(first.ok).toBe(true)
    if (!first.ok || !first.value) throw new Error('未取得当前抖音播放源.')
    expect(first.value.platform).toBe('douyin')
    expect(first.value.url).toMatch(/^app:\/\/app\/buffer\//)
    expect(first.value.danmakuRoom).toBe(`douyin:${first.value.channel}`)
    expect(first.value.headers).toBeUndefined()
    const next = first.value.qualities?.find(item => item.id !== first.value!.quality)
    expect(next, '真实房间应有可切换的画质以完成本项验收.').toBeDefined()
    if (!next) return
    await revealOverlay(page)
    await page.getByRole('button', { name: '解说清晰度', exact: true }).click()
    await page.getByRole('menuitemradio', { name: next.label, exact: true }).click()
    await expect.poll(async () => {
      const current = await invoke(page, 'getStreamPlayback', { id: 'commentary' })
      return current.ok ? current.value?.quality : null
    }, { timeout: 100_000 }).toBe(next.id)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    const afterQuality = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 20_000 }).toBeGreaterThan(afterQuality + 1)

    const panel = await openSourcePanel(page, 'commentary')
    await expect(panel.getByRole('status').filter({ hasText: '抖音弹幕: 已连接房间' })).toBeVisible({ timeout: 60_000 })
    await panel.getByRole('button', { name: '重连抖音弹幕', exact: true }).click()
    await expect(panel.getByRole('button', { name: '重连抖音弹幕', exact: true })).toBeEnabled()
    await expect(panel.getByRole('status').filter({ hasText: '抖音弹幕: 已连接房间' })).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByRole('textbox', { name: '弹幕房间' })).toHaveCount(0)
    await panel.getByRole('button', { name: '收藏', exact: true }).click()
    await expect(panel.getByRole('button', { name: '已收藏', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const saved = await invoke(page, 'listSavedRooms', undefined)
    expect(saved.ok && saved.value.some(room => room.platform === 'douyin')).toBe(true)
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.drawer .msg-text').count(), { timeout: 90_000,
      message: '当前公开房间应在等待期内收到至少一条实际聊天消息.' }).toBeGreaterThan(0)
    await expect(page.locator('.drawer .msg-plus')).toHaveCount(0)
    await expect(page.locator('.drawer').getByRole('button', { name: '房间数据', exact: true })).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('douyin-playback.png') })
    await test.info().attach('playback-evidence', { contentType: 'application/json', body: JSON.stringify(await video.evaluate((node: HTMLVideoElement) => ({
      width: node.videoWidth, height: node.videoHeight, currentTime: node.currentTime,
      readyState: node.readyState, decodedFrames: node.getVideoPlaybackQuality().totalVideoFrames,
    }))) })
  })
})
