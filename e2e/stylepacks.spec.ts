import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createEmptyHudStylePack, parseHudStylePack } from '../src/core/hudStylePack'
import { packBitmap } from '../src/core/bitmapCodec'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import type { StylePackCatalog, StylePackSource } from '../electron/stylePackSyncContracts'
import { expect, launchApplication, test } from './electron'
import { closeSourceDialog, failOnPageError, invoke, openAlignOptions, openSettingsSection } from './helpers'

test('后台和手动同步只更新变化的赛事包, 离线重启仍可使用并保留本机修改', async ({}, testInfo) => {
  const keys = generateKeyPairSync('ed25519')
  const source: StylePackSource = { manifestUrl: 'https://stylepacks.example.test/stable/manifest.json',
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
    return { profile, responses: { [source.manifestUrl]: envelope,
      [new URL(`packs/${sha256}.json`, source.manifestUrl).href]: body } }
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
    await settings.getByRole('button', { name: '立即同步样式包' }).click()
    await expect(settings.getByRole('status')).toHaveText('样式包已是最新')
    expect(await invoke(page, 'getStylePackSyncState', undefined)).toMatchObject({ ok: true, value: { downloaded: 0 } })

    await running.setStylePackResponses(second.responses)
    await settings.getByRole('button', { name: '立即同步样式包' }).click()
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
    await settings.getByRole('button', { name: '立即同步样式包' }).click()
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
  await expect(settings.getByRole('button', { name: '立即同步样式包' })).toBeDisabled()
})
