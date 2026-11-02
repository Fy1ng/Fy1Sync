import { _electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

test('普通模式在生成播放地址前失败后仍能一键导出脱敏诊断', async () => {
  const root = process.cwd()
  const dataRoot = path.join(root, 'e2e/.data')
  await mkdir(dataRoot, { recursive: true })
  const directory = await mkdtemp(path.join(dataRoot, 'diagnostics-'))
  const profile = path.join(directory, 'profile')
  const bootstrap = path.join(directory, 'ordinary-main.cjs')
  // Keep the app in its ordinary runtime mode, while this isolated test blocks external fetches.
  await writeFile(bootstrap, `Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => async () => { throw new Error('Offline diagnostic test'); }, set() {} });
require(${JSON.stringify(path.join(root, 'dist/electron/main.cjs'))});
`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined
    && !/^STREAM_SYNC_|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^NODE_PATH$/i.test(name))) as Record<string, string>
  Object.assign(env, { STREAM_SYNC_E2E: '0', STREAM_SYNC_USER_DATA_DIR: profile, STREAM_SYNC_DATA_DIR: profile,
    STREAM_SYNC_FFMPEG: path.join(directory, 'PRIVATE_PATH_missing-ffmpeg.exe'),
    STREAM_SYNC_FFPROBE: path.join(directory, 'PRIVATE_PATH_missing-ffprobe.exe'),
    STREAM_SYNC_YTDLP: path.join(directory, 'PRIVATE_PATH_missing-ytdlp.exe'),
  })
  const application = await _electron.launch({ args: [bootstrap, '--mute-audio'], cwd: root, env, timeout: 30_000 })
  try {
    const page = await application.firstWindow()
    await page.waitForURL('app://app/**')
    await page.waitForFunction(() => !!window.streamSyncer?.invoke)
    expect(await application.evaluate(() => ({ mode: process.env.STREAM_SYNC_E2E,
      testHook: '__streamSyncerTest' in globalThis }))).toEqual({ mode: '0', testHook: false })
    const before = await page.evaluate(() => window.streamSyncer!.invoke('getAcquisitionDiagnostics', undefined))
    expect(before).toMatchObject({ ok: true, value: { attempts: [] } })
    const failure = await page.evaluate(() => window.streamSyncer!.invoke('resolve', {
      input: 'https://www.youtube.com/watch?v=abcdefghijk', platform: 'youtube', role: 'official',
    }))
    expect(failure).toMatchObject({ ok: false, code: 'tool-not-executable' })

    await page.evaluate(() => {
      const original = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (this.download === 'Fy1Sync-diagnostics.json') {
          const captured = window as typeof window & { __exportedReport?: unknown }
          void fetch(this.href).then(response => response.json()).then(report => { captured.__exportedReport = report })
          return
        }
        original.call(this)
      }
    })
    const skip = page.getByRole('button', { name: '跳过', exact: true })
    if (await skip.isVisible()) await skip.click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('tab', { name: '通用', exact: true }).click()
    await settings.getByRole('tab', { name: '取流工具', exact: true }).click()
    const exportButton = settings.getByRole('button', { name: '导出诊断报告', exact: true })
    await expect(exportButton).toBeEnabled()
    await exportButton.click()
    await expect(settings).toContainText('诊断报告已生成, 请查看下载文件.')
    await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __exportedReport?: unknown }).__exportedReport))).toBe(true)
    const report = await page.evaluate(() => (window as typeof window & { __exportedReport?: unknown }).__exportedReport)
    expect(report).toMatchObject({ schemaVersion: 1, acquisition: { app: { packaged: false },
      attempts: [{ id: 1, role: 'official', status: 'failed', events: expect.arrayContaining([
        expect.objectContaining({ stage: 'resolve', status: 'failed', code: 'tool-not-executable' }),
      ]) }] }, playback: { official: { sampleCount: expect.any(Number) } } })
    const text = JSON.stringify(report)
    expect(text).not.toMatch(/PRIVATE_PATH|abcdefghijk|Cookie|userData|https:\/\/|proxyUrl|stderr/)
    expect(text).not.toContain(directory)
  } finally {
    await application.close()
    if (path.dirname(directory) !== dataRoot || !path.basename(directory).startsWith('diagnostics-')) throw new Error('Invalid diagnostic test cleanup path')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
})
