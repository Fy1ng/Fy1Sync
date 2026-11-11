/** Automatic regions survive a real process restart and remain separate from manual authority. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { SourceRole } from '../src/core/types'
import { SETTINGS_KEY } from '../src/app/settings'
import { expect, launchApplication, test } from './electron'
import { openPlayer, revealOverlay, seekBoth, setPlaying, waitForBothReady } from './helpers'

const officialFile = fileURLToPath(new URL('../public/test-sources/auto-official.mp4', import.meta.url))
const commentaryFile = fileURLToPath(new URL('../public/test-sources/auto-commentary.mp4', import.meta.url))
const roles = ['official', 'commentary'] as const
type RegionMode = 'auto' | 'manual' | 'memory'
interface MemoryRecord { key: string; roi: { x: number; y: number; w: number; h: number }; aspectRatio: number; updatedAt: number }
interface Telemetry {
  configurations: Array<{ kind: string; roiOrigin: RegionMode; hasRoi: boolean }>
  results: Array<{ role: SourceRole; mode: RegionMode; status: string; candidateCount: number }>
}
type ObservedWindow = Window & { basicMemoryTelemetry: Telemetry }

async function installTelemetry(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observed = window as unknown as ObservedWindow
    observed.basicMemoryTelemetry = { configurations: [], results: [] }
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker
      if (String(args[0]).includes('recognition.worker')) {
        worker.addEventListener('message', event => {
          const result = event.data as { type: string; role: SourceRole; basic?: { mode: RegionMode; status: string; candidates?: unknown[] } }
          if (result.type === 'result' && result.basic) observed.basicMemoryTelemetry.results.push({
            role: result.role, mode: result.basic.mode, status: result.basic.status,
            candidateCount: result.basic.candidates?.length ?? 0,
          })
        })
        const post = worker.postMessage.bind(worker)
        worker.postMessage = ((message: unknown, transfer?: Transferable[]) => {
          const request = message as { type?: string; profile?: { kind?: string; roiOrigin?: RegionMode; roi?: unknown } }
          if (request.type === 'configure') observed.basicMemoryTelemetry.configurations.push({
            kind: request.profile?.kind ?? '', hasRoi: !!request.profile?.roi,
            roiOrigin: request.profile?.roiOrigin ?? (request.profile?.roi ? 'manual' : 'auto'),
          })
          post(message, transfer ?? [])
        }) as Worker['postMessage']
      }
      return worker
    } })
  })
}

async function memory(page: Page): Promise<MemoryRecord[]> {
  return page.evaluate(key => {
    const settings = JSON.parse(localStorage.getItem(key) ?? '{}') as { basicClockMemory?: MemoryRecord[] }
    return settings.basicClockMemory ?? []
  }, SETTINGS_KEY)
}

async function telemetry(page: Page): Promise<Telemetry> {
  return page.evaluate(() => (window as unknown as ObservedWindow).basicMemoryTelemetry)
}

async function resetTelemetry(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as ObservedWindow).basicMemoryTelemetry = { configurations: [], results: [] } })
}

function card(page: Page, role: SourceRole) {
  return page.getByRole('article', { name: role === 'official' ? '官方画面基础识别' : '国内解说基础识别', exact: true })
}

async function chooseFile(page: Page, role: SourceRole, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await revealOverlay(page)
  await page.locator(`.chip[data-role="${role}"]`).click()
  const panel = page.getByRole('dialog', { name: role === 'official' ? '画面片源' : '解说片源', exact: true })
  await panel.locator('input[type="file"]').setInputFiles(file)
  await expect(panel).toBeHidden()
}

async function loadFiles(page: Page): Promise<Record<SourceRole, string>> {
  await chooseFile(page, 'official', officialFile)
  await chooseFile(page, 'commentary', commentaryFile)
  await waitForBothReady(page)
  await setPlaying(page, false)
  await seekBoth(page, 8, 8)
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .every(video => !video.seeking && video.readyState >= 2))
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLVideoElement>('video.media-element')]
    .map(video => [video.dataset.role, video.currentSrc || video.src])) as Record<SourceRole, string>)
}

async function align(page: Page, expectSuccess: boolean): Promise<Telemetry> {
  await setPlaying(page, true)
  await page.keyboard.press('a')
  await expect(page.locator('.align-main.is-running')).toHaveCount(1)
  await expect(page.locator('.align-main.is-running')).toHaveCount(0, { timeout: 30_000 })
  if (expectSuccess) await expect(page.locator('.toast').getByText('已自动对齐', { exact: true })).toBeVisible()
  await setPlaying(page, false)
  return telemetry(page)
}

function expectModes(value: Telemetry, expected: Record<SourceRole, RegionMode>): void {
  for (const role of roles) {
    const results = value.results.filter(result => result.role === role)
    expect(results.length, `Expected recognition outcomes for ${role}`).toBeGreaterThan(0)
    expect(new Set(results.map(result => result.mode)), `Unexpected region origin for ${role}`).toEqual(new Set([expected[role]]))
    if (expected[role] === 'memory') expect(results.every(result => result.candidateCount === 0)).toBe(true)
  }
}

test('自动范围跨真实重启及blob变化复用, 共享手动框优先, 显式重找重置当前两路', async ({}, testInfo) => {
  test.skip(!existsSync(officialFile) || !existsSync(commentaryFile), '缺少长倒计时测试源')
  test.setTimeout(150_000)
  const running = await launchApplication('basic clock memory', { softwareVideo: true })
  const reports: Array<{ phase: string; cache: MemoryRecord[]; telemetry: Telemetry }> = []
  try {
    let page = running.page
    await installTelemetry(page)
    await openPlayer(page)
    const firstUrls = await loadFiles(page)
    const first = await align(page, true)
    expectModes(first, { official: 'auto', commentary: 'auto' })
    // Learning a region must not reconfigure the worker halfway through this run.
    expect(first.configurations.filter(configuration => configuration.kind === 'basic-clock')).toHaveLength(2)
    await expect.poll(async () => (await memory(page)).length).toBe(2)
    const saved = await memory(page)
    expect(new Set(saved.map(entry => entry.key)).size).toBe(2)
    expect(JSON.stringify(saved)).not.toMatch(/blob:|auto-official|auto-commentary|https?:/)
    reports.push({ phase: 'first automatic acquisition', cache: saved, telemetry: first })

    await running.restart()
    page = running.page
    await installTelemetry(page)
    await openPlayer(page)
    expect(await memory(page)).toEqual(saved)
    const secondUrls = await loadFiles(page)
    for (const role of roles) {
      expect(firstUrls[role]).toMatch(/^blob:/)
      expect(secondUrls[role]).toMatch(/^blob:/)
      expect(secondUrls[role]).not.toBe(firstUrls[role])
      await expect(card(page, role)).toContainText('记忆范围')
    }
    const reused = await align(page, true)
    expectModes(reused, { official: 'memory', commentary: 'memory' })
    expect(reused.configurations.filter(configuration => configuration.kind === 'basic-clock')).toHaveLength(2)
    expect(reused.results.some(result => result.status === 'locked' && result.role === 'official')).toBe(true)
    expect(reused.results.some(result => result.status === 'locked' && result.role === 'commentary')).toBe(true)
    reports.push({ phase: 'restarted process, changed blobs, fixed remembered regions', cache: await memory(page), telemetry: reused })
    await page.screenshot({ path: testInfo.outputPath('remembered-regions.png') })

    // A new official-region selection overrides both source-specific memories.
    await page.getByRole('button', { name: '框选倒计时', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '倒计时范围 (两路共用)', exact: true })
    await expect(dialog.getByLabel('官方画面当前帧')).toHaveJSProperty('width', 1280)
    await dialog.getByRole('button', { name: '重新绘制', exact: true }).click()
    const bounds = await dialog.getByLabel('官方画面当前帧').boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + bounds!.width * .05, bounds!.y + bounds!.height * .65)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + bounds!.width * .20, bounds!.y + bounds!.height * .78, { steps: 5 })
    await page.mouse.up()
    await dialog.getByRole('button', { name: '使用此范围', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(card(page, 'official')).toContainText('手动范围')
    await resetTelemetry(page)
    const manuallyOverridden = await align(page, false)
    expectModes(manuallyOverridden, { official: 'manual', commentary: 'manual' })
    await expect(card(page, 'official')).toContainText('手动范围未读出倒计时')
    expect(manuallyOverridden.results.filter(result => result.role === 'official').every(result => result.status !== 'locked')).toBe(true)
    expect(await memory(page)).toEqual(saved)
    reports.push({ phase: 'shared manual region overrides both remembered regions without relocating', cache: await memory(page), telemetry: manuallyOverridden })

    await page.getByRole('button', { name: '自动重新寻找', exact: true }).click()
    await expect(card(page, 'official')).toContainText('自动范围')
    await expect.poll(async () => (await memory(page)).length).toBe(0)
    await resetTelemetry(page)
    const reacquired = await align(page, true)
    expectModes(reacquired, { official: 'auto', commentary: 'auto' })
    await expect.poll(async () => (await memory(page)).length).toBe(2)
    reports.push({ phase: 'explicit reacquisition clears memories for the current source pair', cache: await memory(page), telemetry: reacquired })

    // A different file identity must not inherit a same-role remembered ROI.
    await chooseFile(page, 'official', { name: 'different-recording.mp4', mimeType: 'video/mp4', buffer: readFileSync(officialFile) })
    await expect(card(page, 'official')).toContainText('自动范围')
    await expect(card(page, 'official')).not.toContainText('记忆范围')
    await expect(card(page, 'commentary')).toContainText('记忆范围')
  } finally {
    await testInfo.attach('basic-memory-phases', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' })
    await running.close()
  }
})
