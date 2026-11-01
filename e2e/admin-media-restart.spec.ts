/** Restoring or inspecting an editor project must not revoke a video's live range URL. */
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { APP_ORIGIN, expect, launchApplication, test, type RunningApplication } from './electron'
import { chooseEditorVideo, failOnPageError, fixturesReady, invoke } from './helpers'

const official = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

async function restartEditor(running: RunningApplication) {
  let page = running.page
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(running.application, page, official)
  await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
  for (const [index, value] of [0.42, 0.045, 0.16, 0.13].entries()) await page.locator('.roi-fields input').nth(index).fill(String(value))
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('重启后无需重新导入')
  await expect.poll(async () => {
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    return saved.ok ? { name: saved.value.project?.pack.name, media: saved.value.project?.currentMediaId !== null } : null
  }).toEqual({ name: '重启后无需重新导入', media: true })
  const saved = await invoke(page, 'editorProjectLoad', undefined)
  if (!saved.ok || !saved.value.project) throw new Error('Expected a saved project before a real main-process restart')
  const oldSource = await page.locator('video.editor-media').getAttribute('src')
  await running.restart()
  await running.application.evaluate(({ dialog }) => {
    const state = globalThis as typeof globalThis & { __restartPickerCalls?: number }
    state.__restartPickerCalls = 0
    dialog.showOpenDialog = async () => {
      state.__restartPickerCalls!++
      throw new Error('Restarted footage must not need another native file selection')
    }
  })
  page = running.page
  failOnPageError(page)
  const mediaFailures: Array<{ url: string; status: number }> = []
  page.on('response', response => {
    if (response.url().startsWith(APP_ORIGIN + '/editor-media/') && response.status() >= 400) {
      mediaFailures.push({ url: response.url(), status: response.status() })
    }
  })
  await page.goto(APP_ORIGIN + '/admin')
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('重启后无需重新导入')
  await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
  const source = await page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.currentSrc)
  expect(source).toMatch(/^app:\/\/app\/editor-media\//)
  expect(source).not.toBe(oldSource)
  await expect(page.getByTestId('project-note')).toHaveCount(0)
  return { page, source, mediaFailures, project: saved.value.project }
}

async function repeatedProjectReads(page: Page) {
  const sequential = await invoke(page, 'editorProjectLoad', undefined)
  expect(sequential.ok).toBe(true)
  const concurrent = await page.evaluate(() => Promise.all(Array.from({ length: 4 }, () => window.streamSyncer!.invoke('editorProjectLoad', undefined))))
  expect(concurrent.every(result => result.ok && result.value.media !== null)).toBe(true)
}

async function seekAndHash(page: Page, at: number) {
  return page.locator('video.editor-media').evaluate(async (video: HTMLVideoElement, time) => {
    video.pause()
    if (Math.abs(video.currentTime - time) > 1e-6 || video.seeking) await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        video.removeEventListener('seeked', done)
        video.removeEventListener('error', failed)
        if (error) reject(error)
        else resolve()
      }
      const done = () => finish()
      const failed = () => finish(new Error(`Restored video seek failed: ${video.error?.code}`))
      const timer = setTimeout(() => finish(new Error('Restored video seek timed out')), 10_000)
      video.addEventListener('seeked', done)
      video.addEventListener('error', failed)
      video.currentTime = time
    })
    if (video.error || video.readyState < 2) throw new Error('Restored video did not decode the requested frame')
    const canvas = document.createElement('canvas')
    canvas.width = 205; canvas.height = 94
    const context = canvas.getContext('2d')!
    context.drawImage(video, 538, 32, 205, 94, 0, 0, 205, 94)
    return canvas.toDataURL('image/png')
  }, at)
}

test('主进程重启后读取工程不撤销素材地址, 无需重选文件即可播放和定位不同画面', async ({}, testInfo) => {
  test.skip(!fixturesReady(), '需要先运行 npm run fixtures')
  const running = await launchApplication('editor-media-restart-playback', { softwareVideo: true })
  try {
    const { page, source, mediaFailures, project } = await restartEditor(running)
    await repeatedProjectReads(page)
    const responses = await page.evaluate(async url => {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      const ranged = await fetch(url, { headers: { Range: 'bytes=0-31' }, cache: 'no-store' })
      return { head: head.status, range: ranged.status, contentRange: ranged.headers.get('content-range'), bytes: (await ranged.arrayBuffer()).byteLength }
    }, source)
    await testInfo.attach('restored-media-requests.json', { body: JSON.stringify({ responses, mediaFailures }, null, 2), contentType: 'application/json' })
    expect(responses).toMatchObject({ head: 200, range: 206, bytes: 32 })
    expect(responses.contentRange).toMatch(/^bytes 0-31\/\d+$/)
    const first = await seekAndHash(page, 1.5)
    const later = await seekAndHash(page, 4.5)
    expect(later).not.toBe(first)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(5)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    expect(saved.ok && saved.value.project).toEqual(project)
    expect(mediaFailures).toEqual([])
    expect(await running.application.evaluate(() => (globalThis as typeof globalThis & { __restartPickerCalls: number }).__restartPickerCalls)).toBe(0)
  } finally { await running.close() }
})

test('重启后无需播放或重新导入, 直接进入只读验收可取帧并回看', async ({}, testInfo) => {
  test.skip(!fixturesReady(), '需要先运行 npm run fixtures')
  const running = await launchApplication('editor-media-restart-validation', { softwareVideo: true })
  try {
    const { page, source, mediaFailures, project } = await restartEditor(running)
    await repeatedProjectReads(page)
    // Evict HTTP cache so a small fixture cannot conceal an invalidated main-process grant.
    await running.application.evaluate(async ({ session }) => { await session.defaultSession.clearCache() })
    await page.getByRole('button', { name: '只读批量验收', exact: true }).click()
    const panel = page.getByRole('region', { name: '只读批量验收', exact: true })
    await panel.getByRole('spinbutton', { name: '验收开始时间' }).fill('1.5')
    await panel.getByRole('spinbutton', { name: '验收结束时间' }).fill('4.5')
    await panel.getByRole('button', { name: '开始验收', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText(/验收完成|验收中断/, { timeout: 30_000 })
    await testInfo.attach('direct-validation-result.json', { body: JSON.stringify({ status: await panel.getByRole('status').innerText(), mediaFailures }, null, 2), contentType: 'application/json' })
    await expect(panel.getByRole('status')).toHaveText('验收完成: 3 / 3 帧')
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await panel.getByRole('button', { name: '全部', exact: true }).click()
    await expect(panel.getByRole('list', { name: '验收结果', exact: true }).getByRole('listitem')).toHaveCount(3)
    await expect(panel).not.toContainText('取帧或识别调用失败')
    await panel.getByRole('button', { name: '查看 2.50s 验收结果', exact: true }).click()
    await expect(panel.getByRole('img', { name: '倒计时原始画面', exact: true })).toBeVisible()
    await expect(page.locator('video.validation-decoder')).toHaveCount(0)
    expect(await page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => ({ time: video.currentTime, paused: video.paused, source: video.currentSrc })))
      .toEqual({ time: 0, paused: true, source })
    const saved = await invoke(page, 'editorProjectLoad', undefined)
    expect(saved.ok && saved.value.project).toEqual(project)
    expect(mediaFailures).toEqual([])
    expect(await running.application.evaluate(() => (globalThis as typeof globalThis & { __restartPickerCalls: number }).__restartPickerCalls)).toBe(0)
  } finally { await running.close() }
})
