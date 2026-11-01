import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createEmptyHudStylePack, parseHudStylePack } from '../src/core/hudStylePack'
import { packBitmap } from '../src/core/bitmapCodec'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import type { StylePackCatalog, StylePackSource } from '../electron/stylePackSyncContracts'
import { expect, launchApplication, test } from './electron'
import { closeSourceDialog, failOnPageError, invoke, openAlignOptions, openSettingsSection } from './helpers'

test('后台和手动同步只更新变化的赛事包, 离线重启仍可使用并保留本机修改', async ({}, testInfo) => {
  const keys = generateKeyPairSync('ed25519')
  const manifestUrl = 'https://stylepacks.example.test/stable/manifest.json'
  const source: StylePackSource = { mirrors: [{ id: 'github', manifestUrl }],
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
  const fixture = (revision: number) => {
    const profile = createEmptyHudStylePack('cs2/iem', `IEM revision ${revision}`)
    profile.revision = revision
    profile.bitmaps.glyph = { width: 32, height: 48, data: packBitmap(Uint8Array.from({ length: TEMPLATE_PIXELS }, (_, i) => i % 3 ? 0 : 255)) }
    for (const char of CLOCK_CHARS) profile.variants[0]!.fields.clock!.glyphs[char] = ['glyph']
    expect(parseHudStylePack(profile).issues).toEqual([])
    const body = JSON.stringify(profile), sha256 = createHash('sha256').update(body).digest('hex')
    const payload = Buffer.from(JSON.stringify({ kind: 'fy1sync-stylepack-catalog', schemaVersion: 1, revision,
      packs: [{ id: profile.id, revision, sha256, bytes: Buffer.byteLength(body), path: `packs/${sha256}.json`, minAppVersion: '0.2.0' }],
    } satisfies StylePackCatalog))
    const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
    return { profile, responses: { [manifestUrl]: envelope,
      [new URL(`packs/${sha256}.json`, manifestUrl).href]: body } }
  }
  const first = fixture(1), second = fixture(2)
  const running = await launchApplication('cloud style pack sync', { stylePacks: { source, responses: first.responses } })
  try {
    const page = running.page
    failOnPageError(page)
    await closeSourceDialog(page)
    let settings = await openSettingsSection(page, '倒计时样式')
    await expect(settings.getByRole('status')).toHaveText('样式包已更新', { timeout: 25_000 })
    await expect(settings.getByText(/已安装 1 个云端样式包/)).toBeVisible()
    expect(await invoke(page, 'getPreset', { id: first.profile.id })).toMatchObject({ ok: true,
      value: { source: 'cloud', profile: { revision: 1 } } })
    await settings.getByRole('button', { name: '手动刷新' }).click()
    await expect(settings.getByRole('status')).toHaveText('样式包已是最新')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { downloaded: 0 } })

    await running.setStylePackResponses(second.responses)
    await settings.getByRole('button', { name: '手动刷新' }).click()
    await expect(settings.getByRole('status')).toHaveText('样式包已更新')
    await settings.screenshot({ path: testInfo.outputPath('stylepack-sync.png') })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    const options = await openAlignOptions(page)
    await expect(options.getByRole('combobox', { name: '倒计时样式' }).locator('option', { hasText: 'IEM revision 2' })).toHaveCount(1)
    await page.keyboard.press('Escape')

    const local = { ...second.profile, name: 'My IEM override' }
    expect((await invoke(page, 'savePreset', { id: local.id, profile: local })).ok).toBe(true)
    await running.setStylePackResponses(second.responses, true)
    settings = await openSettingsSection(page, '倒计时样式')
    await settings.getByRole('button', { name: '手动刷新' }).click()
    await expect(settings.getByRole('status')).toContainText('同步失败')
    await expect(settings.getByText(/已安装 1 个云端样式包/)).toBeVisible()
    await running.restart()
    expect(await invoke(running.page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { installed: 1 } })
    expect(await invoke(running.page, 'getPreset', { id: local.id })).toMatchObject({ ok: true,
      value: { profile: { name: 'My IEM override' } } })
    expect((await invoke(running.page, 'deletePreset', { id: local.id })).ok).toBe(true)
    expect(await invoke(running.page, 'getPreset', { id: local.id })).toMatchObject({ ok: true,
      value: { source: 'cloud', profile: { revision: 2 } } })
  } finally { await running.close() }
})

test('未配置托管时明确显示未启用并禁用手动同步', async ({ page }) => {
  const settings = await openSettingsSection(page, '倒计时样式')
  await expect(settings.getByRole('status')).toHaveText('尚未启用云端同步')
  await expect(settings.getByRole('button', { name: '手动刷新' })).toBeDisabled()
})

test('选择 GitCode 或 GitHub 后仅手动刷新所选源, 重启保留选择且源失败不覆盖缓存', async ({}, testInfo) => {
  const keys = generateKeyPairSync('ed25519')
  const source: StylePackSource = { publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), mirrors: [
    { id: 'github', manifestUrl: 'https://github-styles.example.test/stable/manifest.json' },
    { id: 'gitcode', manifestUrl: 'https://gitcode-styles.example.test/stable/manifest.json' },
  ] }
  const profile = createEmptyHudStylePack('test/mirrored-iem', 'IEM 镜像测试')
  const body = JSON.stringify(profile), sha256 = createHash('sha256').update(body).digest('hex')
  const payload = Buffer.from(JSON.stringify({ kind: 'fy1sync-stylepack-catalog', schemaVersion: 1, revision: 1,
    packs: [{ id: profile.id, revision: profile.revision, sha256, bytes: Buffer.byteLength(body), path: `packs/${sha256}.json`, minAppVersion: '0.2.0' }],
  } satisfies StylePackCatalog))
  const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
  const mirrorResponses = (id: 'github' | 'gitcode') => {
    const url = source.mirrors.find(item => item.id === id)!.manifestUrl
    return { [url]: envelope, [new URL(`packs/${sha256}.json`, url).href]: body }
  }
  const running = await launchApplication('stylepack selectable mirrors', { stylePacks: { source, responses: mirrorResponses('gitcode') } })
  try {
    let page = running.page
    failOnPageError(page)
    await closeSourceDialog(page)
    let settings = await openSettingsSection(page, '倒计时样式')
    const select = settings.getByRole('combobox', { name: '样式包来源' })
    await expect(select).toHaveValue('github')
    await select.selectOption('gitcode')
    await expect(select).toHaveValue('gitcode')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { source: 'gitcode', installed: 0, checkedAt: null } })
    await settings.getByRole('button', { name: '手动刷新', exact: true }).click()
    await expect(settings.getByRole('status')).toHaveText('样式包已更新')
    expect(await invoke(page, 'getPreset', { id: profile.id })).toMatchObject({ ok: true, value: { source: 'cloud', profile } })
    await settings.screenshot({ path: testInfo.outputPath('gitcode-stylepacks.png') })
    await running.restart()
    page = running.page
    settings = await openSettingsSection(page, '倒计时样式')
    await expect(settings.getByRole('combobox', { name: '样式包来源' })).toHaveValue('gitcode')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { source: 'gitcode', installed: 1, catalogRevision: 1 } })
    await running.setStylePackResponses(mirrorResponses('github'))
    await settings.getByRole('button', { name: '手动刷新', exact: true }).click()
    await expect(settings.getByRole('status')).toContainText('同步失败')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { source: 'gitcode', installed: 1, phase: 'error' } })
    await settings.getByRole('combobox', { name: '样式包来源' }).selectOption('github')
    await settings.getByRole('button', { name: '手动刷新', exact: true }).click()
    await expect(settings.getByRole('status')).toHaveText('样式包已是最新')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { source: 'github', installed: 1, downloaded: 0, phase: 'current' } })
  } finally { await running.close() }
})
