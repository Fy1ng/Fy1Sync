import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { ApplicationUpdateEntry, FrontendBundle, FrontendUpdateEntry, OnlineUpdateCatalog, OnlineUpdateSource, OnlineUpdateSourceId, SignedUpdateCatalog } from '../electron/onlineUpdateContracts'
import frontendBuild from '../packaging/frontend-build.json' with { type: 'json' }
import appPackage from '../package.json' with { type: 'json' }
import { expect, launchApplication, test, type RunningApplication } from './electron'
import { closeSourceDialog, fixturesReady, invoke, openSettings } from './helpers'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const clientDir = path.join(process.env.STREAM_SYNC_E2E_APP_DIR || path.join(projectRoot, 'dist'), 'client')
const markerId = 'online-update-e2e-marker'
const nextRevision = frontendBuild.revision + 1
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
let builtFiles: Promise<FrontendBundle['files']> | undefined

function realFrontendFiles(): Promise<FrontendBundle['files']> {
  return builtFiles ??= (async () => {
    const files: FrontendBundle['files'] = [{ path: 'index.html', content: (await readFile(path.join(clientDir, 'index.html'))).toString('base64') }]
    const assets = await readdir(path.join(clientDir, 'assets'), { withFileTypes: true })
    for (const item of assets.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isFile() || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css|wasm|woff2|png|jpg|jpeg|webp|svg|ico)$/.test(item.name)) continue
      files.push({ path: `assets/${item.name}`, content: (await readFile(path.join(clientDir, 'assets', item.name))).toString('base64') })
    }
    if (files.length < 2 || !files.some(file => file.path.endsWith('.js'))) throw new Error('Build the real client before running the online update E2E')
    return files
  })()
}

function publisher() {
  const keys = generateKeyPairSync('ed25519')
  const source: OnlineUpdateSource = { publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), mirrors: [
    { id: 'github', manifestUrl: 'https://updates.example.org/manifest.json' },
    { id: 'gitcode', manifestUrl: 'https://gitcode.example.org/manifest.json' },
  ] }
  const envelope = (catalog: OnlineUpdateCatalog): SignedUpdateCatalog => {
    const payload = Buffer.from(JSON.stringify(catalog))
    return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  }
  const installerBytes = Buffer.from('SYNTHETIC_NON_EXECUTABLE_INSTALLER_FIXTURE')
  const application: ApplicationUpdateEntry = {
    version: '999.0.0', platform: 'win32', arch: 'x64', sha256: digest(installerBytes), bytes: installerBytes.length,
    notes: 'Synthetic installer metadata only. This E2E must never execute an installer.',
    downloads: { github: { url: 'https://updates.example.org/installer.exe', redirectOrigins: [] },
      gitcode: { url: 'https://gitcode.example.org/installer.exe', redirectOrigins: [] } },
  }
  const release = async (revision: number, broken = false) => {
    const marker = broken ? `SYNTHETIC_BROKEN_FRONTEND_R${revision}` : `SYNTHETIC_FRONTEND_R${revision}`
    const markerPath = `assets/online-update-marker-r${revision}.js`
    let files: FrontendBundle['files']
    if (broken) {
      files = [
        { path: 'index.html', content: Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Broken update fixture</title></head><body><div id="${markerId}">${marker}</div><div id="root"></div><script type="module" src="/${markerPath}"></script></body></html>`).toString('base64') },
        { path: markerPath, content: Buffer.from('throw new Error("SYNTHETIC_FRONTEND_BOOT_FAILURE")').toString('base64') },
      ]
    } else {
      files = (await realFrontendFiles()).map(file => ({ ...file }))
      const index = files.find(file => file.path === 'index.html')!
      const text = Buffer.from(index.content, 'base64').toString('utf8')
      if (!text.includes('</body>')) throw new Error('Missing built client body')
      index.content = Buffer.from(text.replace('</body>', `<div id="${markerId}" style="position:fixed;bottom:8px;right:8px;z-index:100;pointer-events:none;background:#151719;color:#eee;padding:4px;font:12px monospace"></div><script type="module" src="/${markerPath}"></script></body>`)).toString('base64')
      files.push({ path: markerPath, content: Buffer.from(`document.getElementById(${JSON.stringify(markerId)}).textContent = ${JSON.stringify(marker)};`).toString('base64') })
    }
    const version = `${appPackage.version}+ui.${revision}`
    const bundle: FrontendBundle = { kind: 'fy1sync-frontend-bundle', schemaVersion: 1, revision, version, bridgeVersion: frontendBuild.bridgeVersion, files }
    const bytes = Buffer.from(JSON.stringify(bundle)), sha256 = digest(bytes)
    const entry: FrontendUpdateEntry = { revision, version, minAppVersion: appPackage.version, maxAppVersion: appPackage.version,
      bridgeVersion: frontendBuild.bridgeVersion, sha256, bytes: bytes.length, path: `frontends/${sha256}.json`, notes: `Synthetic frontend revision ${revision}.` }
    const signed = envelope({ kind: 'fy1sync-update-catalog', schemaVersion: 1, revision, frontend: entry, application })
    const responses = (ids: OnlineUpdateSourceId[] = ['github', 'gitcode']): Record<string, string> => Object.fromEntries(source.mirrors
      .filter(mirror => ids.includes(mirror.id))
      .flatMap(mirror => [[mirror.manifestUrl, encode(signed)], [new URL(entry.path, mirror.manifestUrl).href, bytes.toString('base64')]]))
    return { entry, signed, marker, markerPath, responses }
  }
  return { source, release, envelope }
}

async function state(page: Page) {
  const result = await invoke(page, 'getOnlineUpdateState', undefined)
  if (!result.ok) throw new Error(`Cannot read online update state: ${result.code}`)
  return result.value
}

async function readyFrontend(running: RunningApplication, revision: number): Promise<void> {
  await expect(running.page.locator('.studio')).toBeVisible()
  await expect.poll(async () => {
    const value = await state(running.page)
    return { revision: value.currentFrontendRevision, phase: value.frontend.phase }
  }, { timeout: 15_000 }).toEqual({ revision, phase: 'current' })
}

async function cancelNativeConfirmation(running: RunningApplication): Promise<void> {
  await running.application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { cancelId?: number }
      return { response: options.cancelId ?? 1, checkboxChecked: false }
    }
  })
}

test('signed frontend updates stay manual, activate offline, and reject tampered cached assets', async ({}, testInfo) => {
  const published = publisher(), release = await published.release(nextRevision)
  const running = await launchApplication('signed frontend activation', { onlineUpdates: { source: published.source, responses: release.responses(['gitcode']) } })
  try {
    await expect(running.page.locator('.studio')).toBeVisible()
    const before = await running.page.evaluate(() => { localStorage.setItem('synthetic:update-preserved', 'yes'); return performance.timeOrigin })
    let settings = await openSettings(running.page, '关于')
    const source = settings.getByRole('combobox', { name: '更新来源' })
    await expect(source).toHaveValue('github')
    expect(await state(running.page)).toMatchObject({ checkedAt: null, currentFrontendRevision: frontendBuild.revision })
    await source.selectOption('gitcode')
    await expect(source).toHaveValue('gitcode')
    expect(await state(running.page)).toMatchObject({ source: 'gitcode', phase: 'idle', checkedAt: null })
    await settings.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(settings.getByRole('button', { name: '下载前端更新', exact: true })).toBeEnabled()
    await settings.getByRole('button', { name: '下载前端更新', exact: true }).click()
    await expect(settings.getByRole('button', { name: '应用并重启', exact: true })).toBeEnabled({ timeout: 30_000 })
    expect(await state(running.page)).toMatchObject({ currentFrontendRevision: frontendBuild.revision, frontend: { phase: 'ready', revision: nextRevision } })
    expect(await running.page.evaluate(() => performance.timeOrigin)).toBe(before)
    await expect(running.page.locator(`#${markerId}`)).toHaveCount(0)

    await cancelNativeConfirmation(running)
    await settings.getByRole('button', { name: '应用并重启', exact: true }).click()
    await expect(settings.getByText('操作已取消, 当前应用继续运行.')).toBeVisible()
    expect(await running.page.evaluate(() => performance.timeOrigin)).toBe(before)
    expect(await state(running.page)).toMatchObject({ frontend: { phase: 'ready', revision: nextRevision } })
    await settings.screenshot({ path: testInfo.outputPath('frontend-staged.png') })

    await running.setOnlineUpdateResponses({}, true)
    await running.restart()
    await expect(running.page.locator(`#${markerId}`)).toHaveText(release.marker)
    await readyFrontend(running, nextRevision)
    expect(await running.page.evaluate(() => localStorage.getItem('synthetic:update-preserved'))).toBe('yes')
    expect(await state(running.page)).toMatchObject({ source: 'gitcode', canRollbackFrontend: true })
    await running.restart()
    await readyFrontend(running, nextRevision)
    await expect(running.page.locator(`#${markerId}`)).toHaveText(release.marker)
    settings = await openSettings(running.page, '关于')
    await cancelNativeConfirmation(running)
    await settings.getByRole('button', { name: '回退前端', exact: true }).click()
    await expect(settings.getByText('操作已取消, 当前应用继续运行.')).toBeVisible()
    expect((await state(running.page)).currentFrontendRevision).toBe(nextRevision)

    const userData = await running.application.evaluate(({ app }) => app.getPath('userData'))
    const expectedRoot = path.resolve(process.env.STREAM_SYNC_E2E_DATA_ROOT || path.join(projectRoot, 'e2e', '.data'))
    const relative = path.relative(expectedRoot, userData)
    if (path.isAbsolute(relative) || !/^[a-f0-9]{8}-[a-f0-9]{3}[\\/]userData$/.test(relative)) throw new Error('Tamper target is not this disposable E2E profile')
    const target = path.join(userData, 'online-updates', 'frontend', 'releases', release.entry.sha256, 'client', release.markerPath)
    const original = await readFile(target, 'utf8')
    const corrupted = original.replace('SYNTHETIC_FRONTEND', 'SYNTHETIC_TAMPERED')
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original))
    expect(corrupted).not.toBe(original)
    await writeFile(target, corrupted)
    await running.restart()
    await expect(running.page.locator('.studio')).toBeVisible()
    await expect(running.page.locator(`#${markerId}`)).toHaveCount(0)
    expect(await state(running.page)).toMatchObject({ currentFrontendRevision: frontendBuild.revision, frontend: { phase: 'rolled-back' } })
    expect(await running.page.evaluate(() => localStorage.getItem('synthetic:update-preserved'))).toBe('yes')
    await running.setOnlineUpdateResponses(release.responses())
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { frontend: { phase: 'rolled-back' } } })
    expect(await invoke(running.page, 'downloadOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: true, value: { currentFrontendRevision: frontendBuild.revision, frontend: { phase: 'rolled-back' } } })
  } finally { await running.close() }
})

test('bad signatures, stale mirrors and cancellation keep the known-good frontend unchanged', async ({}, testInfo) => {
  const published = publisher(), initial = await published.release(nextRevision), later = await published.release(nextRevision + 1)
  const running = await launchApplication('online update failure retention', { onlineUpdates: { source: published.source, responses: initial.responses() } })
  try {
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { frontend: { phase: 'available' } } })
    expect(await invoke(running.page, 'downloadOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: true, value: { frontend: { phase: 'ready' } } })
    await running.restart()
    await readyFrontend(running, nextRevision)
    const before = await running.page.evaluate(() => performance.timeOrigin)
    const responses = later.responses()
    responses[published.source.mirrors[0]!.manifestUrl] = encode({ ...later.signed, signature: Buffer.alloc(64).toString('base64') })
    responses[published.source.mirrors[1]!.manifestUrl] = encode(published.envelope({ kind: 'fy1sync-update-catalog', schemaVersion: 1, revision: 1, frontend: null, application: null }))
    await running.setOnlineUpdateResponses(responses)
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { phase: 'error', currentFrontendRevision: nextRevision, source: 'github' } })
    expect(await invoke(running.page, 'setOnlineUpdateSource', { source: 'gitcode' })).toMatchObject({ ok: true, value: { source: 'gitcode' } })
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { phase: 'error', currentFrontendRevision: nextRevision, source: 'gitcode' } })
    await expect(running.page.locator(`#${markerId}`)).toHaveText(initial.marker)
    const settings = await openSettings(running.page, '关于')
    await expect(settings.getByRole('combobox', { name: '更新来源' })).toHaveValue('gitcode')
    await settings.screenshot({ path: testInfo.outputPath('stale-mirror-retains-frontend.png') })
    await running.setOnlineUpdateResponses(later.responses())
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { frontend: { phase: 'available', revision: nextRevision + 1 } } })
    const cancelled = await running.page.evaluate(async () => {
      const downloading = window.streamSyncer!.invoke('downloadOnlineUpdate', { kind: 'frontend' })
      const cancelled = await window.streamSyncer!.invoke('cancelOnlineUpdate', undefined)
      return { cancelled, download: await downloading }
    })
    expect(cancelled.cancelled).toMatchObject({ ok: true, value: { currentFrontendRevision: nextRevision, frontend: { phase: 'available', revision: nextRevision + 1 } } })
    expect(cancelled.download).toMatchObject({ ok: true, value: { currentFrontendRevision: nextRevision, frontend: { phase: 'available' } } })
    expect(cancelled.cancelled.ok && cancelled.cancelled.value.message).toContain('已取消')
    expect(await running.page.evaluate(() => performance.timeOrigin)).toBe(before)
    await running.setOnlineUpdateResponses({}, true)
    await running.restart()
    await expect(running.page.locator('.studio')).toBeVisible()
    await expect(running.page.locator(`#${markerId}`)).toHaveText(initial.marker)
    expect((await state(running.page)).currentFrontendRevision).toBe(nextRevision)
  } finally { await running.close() }
})

test('a broken signed frontend times out, rolls back, and is not tried again on the next offline boot', async ({}, testInfo) => {
  const published = publisher(), broken = await published.release(nextRevision, true)
  const running = await launchApplication('broken signed frontend rollback', { onlineUpdates: { source: published.source, responses: broken.responses() } })
  try {
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { frontend: { phase: 'available' } } })
    expect(await invoke(running.page, 'downloadOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: true, value: { frontend: { phase: 'ready' } } })
    await running.setOnlineUpdateResponses({}, true)
    await running.restart()
    await expect(running.page.locator(`#${markerId}`)).toHaveText(broken.marker)
    expect(await state(running.page)).toMatchObject({ currentFrontendRevision: nextRevision, frontend: { phase: 'trial' } })
    await expect(running.page.locator('.studio')).toBeVisible({ timeout: 45_000 })
    await expect(running.page.locator(`#${markerId}`)).toHaveCount(0)
    expect(await state(running.page)).toMatchObject({ currentFrontendRevision: frontendBuild.revision, frontend: { phase: 'rolled-back' } })
    await closeSourceDialog(running.page)
    const settings = await openSettings(running.page, '关于')
    await settings.screenshot({ path: testInfo.outputPath('frontend-automatic-rollback.png') })
    await running.restart()
    await expect(running.page.locator('.studio')).toBeVisible({ timeout: 10_000 })
    await expect(running.page.locator(`#${markerId}`)).toHaveCount(0)
    expect((await state(running.page)).currentFrontendRevision).toBe(frontendBuild.revision)
    await running.setOnlineUpdateResponses(broken.responses())
    expect(await invoke(running.page, 'checkOnlineUpdate', undefined)).toMatchObject({ ok: true, value: { frontend: { phase: 'rolled-back' } } })
    expect(await invoke(running.page, 'downloadOnlineUpdate', { kind: 'frontend' })).toMatchObject({ ok: true, value: { frontend: { phase: 'rolled-back' } } })
  } finally { await running.close() }
})

test('update privileges stay in the main window and unpackaged builds cannot install application updates', async () => {
  test.skip(!fixturesReady(), 'Run npm run fixtures to prepare isolated PiP playback media')
  const published = publisher(), release = await published.release(nextRevision, true)
  const running = await launchApplication('online update window authorization', { onlineUpdates: { source: published.source, responses: release.responses() } })
  try {
    const checked = await invoke(running.page, 'checkOnlineUpdate', undefined)
    expect(checked).toMatchObject({ ok: true, value: { application: { phase: 'incompatible', version: '999.0.0' } } })
    expect(await invoke(running.page, 'downloadOnlineUpdate', { kind: 'application' })).toMatchObject({ ok: true, value: { application: { phase: 'incompatible' } } })
    expect(await invoke(running.page, 'resolve', { input: '/test-sources/official.mp4', role: 'official' })).toMatchObject({ ok: true, value: { ok: true } })
    const created = running.application.waitForEvent('window')
    expect(await invoke(running.page, 'openEnhancedPip', { id: 'official' })).toMatchObject({ ok: true })
    const pip = await created
    await pip.waitForURL('app://app/pip')
    const results = await pip.evaluate(async bridgeVersion => {
      const api = window.streamSyncer!
      return Promise.all([
        api.invoke('getOnlineUpdateState', undefined), api.invoke('setOnlineUpdateSource', { source: 'gitcode' }),
        api.invoke('checkOnlineUpdate', undefined), api.invoke('downloadOnlineUpdate', { kind: 'frontend' }),
        api.invoke('cancelOnlineUpdate', undefined), api.invoke('applyOnlineUpdate', { kind: 'frontend' }),
        api.invoke('rollbackFrontendUpdate', undefined), api.invoke('reportFrontendReady', { bridgeVersion }),
      ])
    }, frontendBuild.bridgeVersion)
    expect(results).toHaveLength(8)
    for (const result of results) expect(result).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await state(running.page)).toMatchObject({ source: 'github', currentFrontendRevision: frontendBuild.revision, frontend: { phase: 'available' }, application: { phase: 'incompatible' } })
    expect(await invoke(running.page, 'closeEnhancedPip', undefined)).toMatchObject({ ok: true })
  } finally { await running.close() }
})
