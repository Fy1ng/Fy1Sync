import { locateTool } from '../electron/toolLocator'
import { APP_ORIGIN, expect, test } from './electron'
import { closeSourceDialog, invoke, loadSource, openPlayer, setPlaying } from './helpers'

const platforms = [
  { platform: 'youtube', role: 'official', variable: 'STREAM_SYNC_YOUTUBE_LIVE_URL' },
  { platform: 'douyu', role: 'commentary', variable: 'STREAM_SYNC_DOUYU_LIVE_URL' },
] as const

for (const { platform, role, variable } of platforms) {
  test.describe(`opt-in real ${platform} acquisition`, () => {
    test.skip(process.env.STREAM_SYNC_LIVE_TESTS !== '1', '真实平台网络测试默认关闭, 需显式设置 STREAM_SYNC_LIVE_TESTS=1.')
    test.skip(!process.env[variable], `需设置 ${variable} 为当前公开直播间地址.`)
    test.beforeAll(async () => {
      const tools = platform === 'youtube' ? ['ffmpeg', 'ffprobe', 'yt-dlp'] as const : ['ffmpeg', 'ffprobe'] as const
      for (const tool of tools) {
        try { await locateTool(tool) }
        catch { test.skip(true, `缺少 ${tool}, 请配置对应 STREAM_SYNC 工具环境变量或 PATH.`) }
      }
    })

    test('resolves through real IPC and plays the resulting local buffer', async ({ page }) => {
      test.setTimeout(180_000)
      // launchApplication always owns a disposable data directory. Existing login profiles
      // and cookie files are intentionally never copied into a network smoke test.
      test.info().annotations.push({ type: 'authentication', description: '独立 E2E 数据目录, 使用匿名账号状态. 本场景不验证手工登录.' })
      await openPlayer(page)
      const result = await invoke(page, 'resolve', { input: process.env[variable]!, platform, role })
      expect(result.ok, '真实主进程 resolve IPC 应成功完成.').toBe(true)
      if (!result.ok) throw new Error(`平台取流 IPC 失败: ${result.code}`)
      expect(result.value.ok, '平台应返回可播放结果. 匿名 YouTube 可能因验证要求而失败, 这不是登录验收.').toBe(true)
      if (!result.value.ok) throw new Error(`平台取流失败: ${result.value.failure.code}`)
      const url = result.value.stream.url
      expect(url.startsWith(APP_ORIGIN + '/buffer/')).toBe(true)
      expect(result.value.stream.kind).toBe('hls')
      expect(result.value.stream.qualities?.length ?? 0).toBeGreaterThan(0)

      await expect.poll(async () => page.evaluate(async playlist => {
        const response = await fetch(playlist, { cache: 'no-store' })
        if (!response.ok) return 0
        const text = await response.text()
        return [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum, match) => sum + Number(match[1]), 0)
      }, url), { timeout: 60_000, intervals: [500, 1_000, 2_000], message: '真实直播应在本地缓冲中形成至少 8 秒媒体.' }).toBeGreaterThanOrEqual(8)

      // Load the already resolved capability through the real UI without resolving twice.
      await loadSource(page, role, url.slice(APP_ORIGIN.length))
      await closeSourceDialog(page)
      const video = page.locator(`video[data-role="${role}"]`)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
      await setPlaying(page, true)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false)
      const startedAt = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime), { timeout: 20_000 }).toBeGreaterThan(startedAt + 1)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.seekable.length)).toBeGreaterThan(0)
    })
  })
}
