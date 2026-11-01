/** Real pointer/keyboard activation must stop, not submit a replacement restart button. */
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN, expect, test } from './electron'
import { chooseEditorVideo, failOnPageError, fixturesReady, invoke } from './helpers'

const official = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))

for (const activation of ['pointer', 'Enter', 'Space'] as const) test(`真实 ${activation} 停止验收只停止一次, 不提交重新验收`, async ({ page, electronApp }, testInfo) => {
  test.skip(!fixturesReady(), '缺少测试源, 先运行 npm run fixtures')
  failOnPageError(page)
  await page.goto(APP_ORIGIN + '/admin')
  await chooseEditorVideo(electronApp, page, official)
  const editorVideo = page.locator('video.editor-media')
  await expect.poll(() => editorVideo.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
  const before = await invoke(page, 'editorProjectLoad', undefined)
  if (!before.ok || !before.value.project) throw new Error('Expected a saved editor project')
  const pack = before.value.project.pack
  await page.getByRole('button', { name: '只读批量验收', exact: true }).click()
  const panel = page.getByRole('region', { name: '只读批量验收', exact: true })
  await panel.getByRole('button', { name: '选择全片', exact: true }).click()
  await panel.getByRole('combobox', { name: '验收抽样间隔', exact: true }).selectOption('0.5')
  // Delay only native seek dispatch so this short fixture has an outstanding decode when
  // an actual input event reaches Stop. Pixels, WASM, cancellation and IPC remain real.
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!
    const state = window as typeof window & { __validationStarts?: number; __validationEvents?: string[] }
    state.__validationStarts = 0
    state.__validationEvents = []
    const append = document.body.append.bind(document.body)
    document.body.append = (...nodes) => {
      for (const node of nodes) if (node instanceof HTMLVideoElement && node.classList.contains('validation-decoder')) state.__validationStarts!++
      append(...nodes)
    }
    document.addEventListener('submit', event => {
      if ((event.target as Element).classList.contains('batch-validation-range')) state.__validationEvents!.push(`submit: ${(event as SubmitEvent).submitter?.textContent}`)
    }, true)
    document.addEventListener('click', event => {
      const button = (event.target as Element).closest('button')
      if (button?.closest('.batch-validation-range')) state.__validationEvents!.push(`click: ${button.textContent} / ${button.type} / trusted=${event.isTrusted}`)
    }, true)
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      ...descriptor,
      set(this: HTMLMediaElement, value: number) {
        if (!this.classList.contains('validation-decoder')) { descriptor.set!.call(this, value); return }
        setTimeout(() => { if (this.isConnected) descriptor.set!.call(this, value) }, 60)
      },
    })
  })
  await panel.getByRole('button', { name: '开始验收', exact: true }).click()
  const progress = panel.getByRole('progressbar', { name: '验收进度' })
  await expect.poll(() => progress.getAttribute('value')).not.toBe('0')
  const stop = panel.getByRole('button', { name: '停止验收', exact: true })
  if (activation === 'pointer') await stop.click()
  else await stop.press(activation)
  const stopEvents = await page.evaluate(() => {
    const state = window as typeof window & { __validationStarts: number; __validationEvents: string[] }
    return { starts: state.__validationStarts, events: state.__validationEvents,
      status: document.querySelector('.batch-validation-progress [role="status"]')?.textContent }
  })
  await testInfo.attach('stop-event.json', { contentType: 'application/json', body: JSON.stringify(stopEvents, null, 2) })
  expect(stopEvents.starts, JSON.stringify(stopEvents)).toBe(1)
  await expect(panel.getByRole('status').filter({ hasText: '已停止验收' })).toBeVisible()
  const stoppedAt = Number(await progress.getAttribute('value'))
  expect(stoppedAt).toBeGreaterThan(0)
  expect(stoppedAt).toBeLessThan(Number(await progress.getAttribute('max')))
  await expect(page.locator('video.validation-decoder')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '重新验收', exact: true })).toBeEnabled()
  // Outlast the delayed seek and multiple render turns to catch an automatic new scan.
  await page.waitForTimeout(250)
  expect(Number(await progress.getAttribute('value'))).toBe(stoppedAt)
  expect(await page.evaluate(() => (window as typeof window & { __validationStarts: number }).__validationStarts)).toBe(1)
  const after = await invoke(page, 'editorProjectLoad', undefined)
  expect(after.ok && after.value.project?.pack).toEqual(pack)
  expect(await editorVideo.evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(0)
  await panel.getByRole('spinbutton', { name: '验收结束时间', exact: true }).fill('0.5')
  await panel.getByRole('button', { name: '重新验收', exact: true }).click()
  await expect(panel.getByRole('status').filter({ hasText: '验收完成' })).toHaveText('验收完成: 1 / 1 帧')
  expect(await page.evaluate(() => (window as typeof window & { __validationStarts: number }).__validationStarts)).toBe(2)
})
