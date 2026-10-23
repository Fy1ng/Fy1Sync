import { mkdir, writeFile } from 'node:fs/promises'
import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { decodingStartup, selectSoftwareDecoding } from './decoderSettings'
import { closeSourceDialog, loadSource, openPlayer, openSourceDialog, revealOverlay } from './helpers'

test('decoder preference survives restarts through UI and does not interrupt current playback', async ({}, testInfo) => {
  const running = await launchApplication('decoder-settings', { softwareVideo: false })
  const evidence: unknown[] = []
  try {
    await openPlayer(running.page)
    evidence.push(await decodingStartup(running))
    expect(evidence[0]).toMatchObject({ preferences: { ok: true, value: { mode: 'auto', effectiveMode: 'auto', restartRequired: false } }, switches: { videoDisabled: false, gpuDisabled: false, gpuCompositingDisabled: false } })
    await loadSource(running.page, 'official', '/test-sources/official.mp4')
    await closeSourceDialog(running.page)
    const video = running.page.locator('video[data-role="official"]')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState)).toBeGreaterThanOrEqual(2)
    await revealOverlay(running.page)
    await running.page.locator('.play-button').click()
    const before = await video.evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, src: node.currentSrc }))
    await selectSoftwareDecoding(running, true)
    await expect(running.page.getByRole('status').filter({ hasText: '当前生效:' })).toContainText('当前生效: 自动解码 (硬件优先). 已保存, 待重启: 软件解码兼容模式.')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(before.time)
    expect(await video.evaluate((node: HTMLVideoElement) => ({ paused: node.paused, src: node.currentSrc }))).toEqual({ paused: false, src: before.src })
    evidence.push(await decodingStartup(running))
    await closeSourceDialog(running.page)
    await openSourceDialog(running.page)
    await expect(running.page.getByRole('checkbox', { name: '软件解码兼容模式' })).toBeChecked()
    await mkdir(testInfo.outputDir, { recursive: true })
    await running.page.screenshot({ path: testInfo.outputPath('decoder-pending-desktop.png'), fullPage: true, animations: 'disabled' })
    await running.page.setViewportSize({ width: 1024, height: 700 })
    await running.page.getByRole('heading', { name: '视频解码' }).scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('decoder-pending-narrow.png'), fullPage: true, animations: 'disabled' })
    await running.restart()
    await openPlayer(running.page)
    evidence.push(await decodingStartup(running))
    expect(evidence[2]).toMatchObject({ preferences: { ok: true, value: { mode: 'software', effectiveMode: 'software', restartRequired: false, forcedByCommandLine: false } }, switches: { videoDisabled: true, gpuDisabled: false, gpuCompositingDisabled: false } })
    await openSourceDialog(running.page)
    await expect(running.page.getByRole('status').filter({ hasText: '当前生效:' })).toContainText('当前生效: 软件解码兼容模式. 已保存的选择与当前模式一致.')
    await selectSoftwareDecoding(running, false)
    evidence.push(await decodingStartup(running))
    expect(evidence[3]).toMatchObject({ preferences: { ok: true, value: { mode: 'auto', effectiveMode: 'software', restartRequired: true } } })
    await running.restart()
    evidence.push(await decodingStartup(running))
    expect(evidence[4]).toMatchObject({ preferences: { ok: true, value: { mode: 'auto', effectiveMode: 'auto', restartRequired: false } }, switches: { videoDisabled: false, gpuDisabled: false, gpuCompositingDisabled: false } })
  } finally {
    await mkdir(testInfo.outputDir, { recursive: true })
    await writeFile(testInfo.outputPath('decoder-settings.json'), JSON.stringify(evidence, null, 2))
    await running.close()
  }
})
