/** A native file grant and unpublished draft survive the whole application's lifetime. */
import { copyFile, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { APP_ORIGIN, expect, launchApplication, test } from './electron'
import { chooseEditorVideo, fixturesReady, invoke } from './helpers'

test('编辑工程重启恢复未发布草稿和素材, 文件改名后按 SHA-256 接续', async ({}, testInfo) => {
  test.skip(!fixturesReady(), '需要先运行 npm run fixtures')
  test.setTimeout(120_000)
  const original = testInfo.outputPath('project-video.mp4')
  const moved = testInfo.outputPath('renamed-video.mp4')
  await mkdir(path.dirname(original), { recursive: true })
  await copyFile(fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url)), original)
  const running = await launchApplication('editor-project', { softwareVideo: true })
  try {
    let page = running.page
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(running.application, page, original)
    await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.videoWidth)).toBe(1280)
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('未发布但已自动记住')
    await page.getByLabel('素材比赛').fill('PGL / A vs B / Map 2')
    await page.getByLabel('素材用途').selectOption('validation')
    // This invoke follows the autosave on the same IPC channel and inspects the persisted snapshot.
    await expect.poll(async () => {
      const saved = await invoke(page, 'editorProjectLoad', undefined)
      return saved.ok && saved.value.project?.pack.name
    }).toBe('未发布但已自动记住')
    await running.restart()
    page = running.page
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('未发布但已自动记住')
    await expect(page.getByLabel('素材比赛')).toHaveValue('PGL / A vs B / Map 2')
    await expect(page.getByLabel('素材用途')).toHaveValue('validation')
    await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
    await running.application.close()
    await rename(original, moved)
    await running.restart()
    page = running.page
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.getByTestId('project-note')).toContainText('重新选择')
    await chooseEditorVideo(running.application, page, moved, '重新选择原素材')
    await expect(page.getByTestId('project-note')).toHaveCount(0)
    await expect.poll(() => page.locator('video.editor-media').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
    await expect(page.getByLabel('素材用途')).toHaveValue('validation')
  } finally { await running.close() }
})
