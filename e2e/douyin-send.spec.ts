import { expect, test } from './electron'
import { connectDanmaku, fixturesReady, invoke, openPlayer } from './helpers'
import type { DouyinSendFixtureScenario } from '../electron/douyinMessageFixtures'

test.beforeEach(async () => { test.skip(!fixturesReady(), '需要本地合成媒体素材.') })
for (const scenario of ['accepted','challenge','unknown','logged-out','token-unavailable','http-forbidden','rate-limited'] as const) {
  test(`抖音手动 HTTP 发送经过真实 IPC 和本地签名, 离线场景 ${scenario}`, async ({ page, electronApp }) => {
    await electronApp.evaluate((_electron, selected: DouyinSendFixtureScenario) => {
      (globalThis as typeof globalThis & { __streamSyncerTest: { setDouyinSendFixture(value: DouyinSendFixtureScenario): void } }).__streamSyncerTest.setDouyinSendFixture(selected)
    }, scenario)
    await openPlayer(page)
    // A call without the current window's connected subscription is refused before HTTP.
    expect(await invoke(page,'sendDouyinMessage',{ room:'douyin:100',expectedUid:'12345',text:'不得发送' }))
      .toMatchObject({ ok:false,code:'room-not-subscribed' })
    await connectDanmaku(page,'douyin:100')
    const composer = page.getByRole('form',{ name:'抖音弹幕发送' })
    const input = composer.getByRole('textbox',{ name:'抖音弹幕内容' })
    const read = () => electronApp.evaluate(() =>
      (globalThis as typeof globalThis & { __streamSyncerTest: { getDouyinSendFixture(): { scenario: string; tokenRequests:number; sent:Array<{ room:string; text:string; signed:boolean }> } } })
        .__streamSyncerTest.getDouyinSendFixture())
    if (scenario === 'logged-out') {
      await expect(input).toBeDisabled()
      await expect(composer.getByRole('button',{ name:'登录抖音',exact:true })).toBeVisible()
      expect((await read()).sent).toEqual([])
      return
    }
    await expect(input).toBeEnabled()
    expect((await read()).tokenRequests).toBe(0)
    await input.fill('本地发送验证 + & 😀')
    await input.press('Enter')
    if (scenario === 'token-unavailable') {
      await expect(composer.getByRole('status')).toContainText('发送准备失败')
      await expect(input).toHaveValue('本地发送验证 + & 😀')
      await expect(composer.getByRole('button',{ name:'重新登录抖音' })).toHaveCount(0)
      expect((await read()).sent).toEqual([])
      expect((await read()).tokenRequests).toBe(1)
      return
    }
    await expect.poll(async () => (await read()).sent.length).toBe(1)
    const report = await read()
    expect(report.tokenRequests).toBe(1)
    expect(report.sent).toEqual([{ room:'9000000000000000001',text:'本地发送验证 + & 😀',signed:true,ticketSigned:false,pageGuard:false }])
    if (scenario === 'accepted') {
      await expect(composer.getByRole('status')).toContainText('尚未确认房间内显示')
      await expect(input).toHaveValue('')
    } else {
      const status = composer.getByRole('status')
      await expect(status).toContainText(scenario === 'challenge' ? '安全验证' : scenario === 'http-forbidden' ? 'HTTP 403' : scenario === 'rate-limited' ? 'HTTP 429' : '无法确认')
      if (scenario === 'http-forbidden') await expect(status).toContainText('未返回明确的安全验证指令')
      if (scenario === 'rate-limited') await expect(status).toContainText('请求频率')
      await expect(input).toHaveValue('本地发送验证 + & 😀')
    }
    await input.press('Enter')
    expect((await read()).sent).toHaveLength(1)
    await page.screenshot({ path:test.info().outputPath(`douyin-send-${scenario}.png`) })
  })
}
