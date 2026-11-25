import { expect, test } from './electron'

test('添加直播间显示一键选择赛程文案, 基础错误隐藏原始错误且疑难错误按钮保持单行横向排列', async ({ electronApp, page }) => {
  const intake = page.getByRole('dialog', { name: '添加直播间', exact: true })
  await expect(intake).toBeVisible()
  await expect(intake.getByRole('button', { name: /^CS2 赛程/ })).toContainText('支持一键选择直播间')

  await intake.getByRole('radio', { name: /画面/ }).click()
  const field = intake.getByRole('textbox', { name: '直播间链接' })

  // A8: self-explanatory input validation hides raw error button
  await field.fill('https://live.bilibili.com/')
  await intake.getByRole('button', { name: '添加', exact: true }).click()
  const basicInputAlert = intake.getByRole('alert')
  await expect(basicInputAlert).toContainText('哔哩哔哩链接缺少房间号')
  await expect(basicInputAlert.getByRole('button', { name: '查看原始错误' })).toHaveCount(0)

  // A3: Bilibili explicit login-required (-101) shows login button without raw error toggle
  await electronApp.evaluate(() => {
    if (process.env.STREAM_SYNC_OFFLINE_E2E !== '1') throw new Error('Offline E2E required')
    const state = globalThis as typeof globalThis & { __origFetch?: typeof fetch }
    state.__origFetch ??= globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'api.live.bilibili.com') {
        return Response.json({ code: -101, message: '账号未登录' })
      }
      return state.__origFetch!(input, init)
    }
  })

  await field.fill('https://live.bilibili.com/21452505')
  await intake.getByRole('button', { name: '添加', exact: true }).click()
  await expect(intake.getByRole('button', { name: '登录哔哩哔哩并重试' })).toBeVisible()
  await expect(intake.getByRole('button', { name: '查看原始错误' })).toHaveCount(0)

  // B3/B4: technical network failure aligns quick-fix buttons and raw-error toggle on one horizontal row
  await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __origFetch?: typeof fetch }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'api.live.bilibili.com') {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        throw err
      }
      return state.__origFetch!(input, init)
    }
  })

  await field.fill('https://live.bilibili.com/21452505')
  await intake.getByRole('button', { name: '添加', exact: true }).click()

  const netBtn = intake.getByRole('button', { name: '网络设置', exact: true })
  const retryBtn = intake.getByRole('button', { name: '重试', exact: true })
  const rawBtn = intake.getByRole('button', { name: '查看原始错误', exact: true })
  await expect(netBtn).toBeVisible()
  await expect(retryBtn).toBeVisible()
  await expect(rawBtn).toBeVisible()

  const boxes = await Promise.all([netBtn.boundingBox(), retryBtn.boundingBox(), rawBtn.boundingBox()])
  expect(boxes[0]).not.toBeNull()
  expect(boxes[1]).not.toBeNull()
  expect(boxes[2]).not.toBeNull()
  const centerY = (box: NonNullable<typeof boxes[0]>) => box.y + box.height / 2
  expect(Math.abs(centerY(boxes[0]!) - centerY(boxes[1]!))).toBeLessThan(4)
  expect(Math.abs(centerY(boxes[0]!) - centerY(boxes[2]!))).toBeLessThan(4)

  // Expanding raw error panel keeps buttons aligned on the same horizontal row above it
  await rawBtn.click()
  const rawPanel = intake.getByRole('region', { name: '原始错误信息' })
  await expect(rawPanel).toBeVisible()
  const collapseBtn = intake.getByRole('button', { name: '收起原始错误', exact: true })
  const [netAfter, retryAfter, collapseBox, panelBox] = await Promise.all([
    netBtn.boundingBox(),
    retryBtn.boundingBox(),
    collapseBtn.boundingBox(),
    rawPanel.boundingBox(),
  ])
  expect(Math.abs(centerY(netAfter!) - centerY(retryAfter!))).toBeLessThan(4)
  expect(Math.abs(centerY(netAfter!) - centerY(collapseBox!))).toBeLessThan(4)
  expect(panelBox!.y).toBeGreaterThanOrEqual(netAfter!.y + netAfter!.height - 1)

  // Clicking 网络设置 jumps directly to 设置 -> 通用 -> 网络
  await netBtn.click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('region', { name: '网络' })).toBeVisible()
  await settings.getByRole('button', { name: '关闭', exact: true }).click()

  // B6: media codec unsupported shows 解码设置, 重试 and 查看原始错误 on one horizontal row and opens 解码 page
  await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & { __origFetch?: typeof fetch }
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'gql.twitch.tv') {
        return new Response('Service Unavailable', { status: 503 })
      }
      return state.__origFetch!(input, init)
    }
  })

  await field.fill('https://www.twitch.tv/pgl')
  await intake.getByRole('button', { name: '添加', exact: true }).click()
  const twitchRetry = intake.getByRole('button', { name: '重试', exact: true })
  const twitchRaw = intake.getByRole('button', { name: '查看原始错误', exact: true })
  await expect(twitchRetry).toBeVisible()
  await expect(twitchRaw).toBeVisible()
  const [tRetryBox, tRawBox] = await Promise.all([twitchRetry.boundingBox(), twitchRaw.boundingBox()])
  expect(Math.abs(centerY(tRetryBox!) - centerY(tRawBox!))).toBeLessThan(4)
})
