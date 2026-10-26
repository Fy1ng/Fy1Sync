import { mkdir, writeFile } from 'node:fs/promises'
import { test } from '@playwright/test'
import { expect, launchApplication } from './electron'
import { decodingStartup, selectSoftwareDecoding } from './decoderSettings'
import { closeSourceDialog, loadSource, openPlayer, openSettings, setPlaying } from './helpers'

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
    await setPlaying(running.page, true)
    const before = await video.evaluate((node: HTMLVideoElement) => ({ time: node.currentTime, src: node.currentSrc }))
    await selectSoftwareDecoding(running, true)
    await expect(running.page.getByText('重启后改为软件解码，当前仍是硬件解码', { exact: true })).toBeVisible()
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeGreaterThan(before.time)
    expect(await video.evaluate((node: HTMLVideoElement) => ({ paused: node.paused, src: node.currentSrc }))).toEqual({ paused: false, src: before.src })
    evidence.push(await decodingStartup(running))
    await running.page.getByRole('dialog', { name: '设置', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
    await openSettings(running.page, '解码')
    await expect(running.page.getByRole('switch', { name: /^软件解码/ })).toBeChecked()
    await mkdir(testInfo.outputDir, { recursive: true })
    await running.page.screenshot({ path: testInfo.outputPath('decoder-pending-desktop.png'), fullPage: true, animations: 'disabled' })
    await running.page.setViewportSize({ width: 1024, height: 700 })
    await running.page.getByRole('heading', { name: '解码', exact: true }).scrollIntoViewIfNeeded()
    await running.page.screenshot({ path: testInfo.outputPath('decoder-pending-narrow.png'), fullPage: true, animations: 'disabled' })
    await running.restart()
    await openPlayer(running.page)
    evidence.push(await decodingStartup(running))
    expect(evidence[2]).toMatchObject({ preferences: { ok: true, value: { mode: 'software', effectiveMode: 'software', restartRequired: false, forcedByCommandLine: false } }, switches: { videoDisabled: true, gpuDisabled: false, gpuCompositingDisabled: false } })
    const settings = await openSettings(running.page, '解码')
    await expect(settings.getByRole('switch', { name: /^软件解码/ })).toBeChecked()
    await expect(settings.getByRole('region', { name: '解码', exact: true }).locator('.note-warn')).toHaveCount(0)
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
