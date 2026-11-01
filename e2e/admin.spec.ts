/** The local editor: trusted app access, decoded-frame teaching and preset IPC. */

import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Page } from '@playwright/test'
import { createEmptyHudStylePack, type HudStylePack } from '../src/core/hudStylePack'
import { CLOCK_CHARS, TEMPLATE_PIXELS } from '../src/core/profileSchema'
import { packBitmap } from '../src/core/bitmapCodec'
import { APP_ORIGIN, expect, test } from './electron'
import { chooseEditorVideo, closeSourceDialog, failOnPageError, fixturesReady, invoke, loadBothFixtures, mediaTimes, openAlignOptions, openPlayer, openSettingsSection, setPlaying, sourceDialog } from './helpers'

const officialPath = fileURLToPath(new URL('../public/test-sources/official.mp4', import.meta.url))
const framePath = fileURLToPath(new URL('../public/test-sources/frame-0-20.png', import.meta.url))

test.describe('本机编辑器访问', () => {
  test('草稿修改必须发布后才能应用, 返回播放器读取已发布版本', async ({ page }) => {
    failOnPageError(page)
    const id = 'e2e/draft-publication'
    const profile = baseProfile(id)
    const data = packBitmap(Uint8Array.from({ length: TEMPLATE_PIXELS }, (_, i) => i % 3 ? 0 : 255))
    for (const char of CLOCK_CHARS) {
      const bitmapId = `clock-${char === ':' ? 'colon' : char}`
      profile.bitmaps[bitmapId] = { width: 32, height: 48, data }
      profile.variants[0]!.fields.clock!.glyphs[char] = [bitmapId]
    }
    const seeded = await invoke(page, 'savePreset', { id, profile })
    expect(seeded.ok).toBe(true)
    await page.goto(APP_ORIGIN + '/admin')
    await openLibrary(page)
    await page.getByRole('button', { name: /种子预设/ }).click()
    await setField(page, '名称', '草稿中的修改')
    await page.getByRole('button', { name: '存为草稿', exact: true }).click()
    await expect(page.locator('.editor-note')).toContainText('已保存到本机草稿')
    await page.getByRole('button', { name: '应用到播放器' }).click()
    await expect(page.locator('.editor-note')).toContainText('请先')
    const before = await invoke(page, 'getPreset', { id })
    expect(before.ok && before.value.profile.name).toBe('种子预设')
    await page.getByRole('button', { name: '发布到本机', exact: true }).click()
    await expect(page.locator('.editor-note')).toContainText('已发布为本机预设')
    await page.getByRole('button', { name: '应用到播放器' }).click()
    await expect(page.locator('.editor-note')).toContainText('已设为播放器的倒计时样式')
    await page.getByRole('link', { name: '返回播放器' }).click()
    await expect(sourceDialog(page)).toBeVisible()
    await closeSourceDialog(page)
    const options = await openAlignOptions(page)
    await expect(options.getByRole('combobox', { name: '倒计时样式' }).locator('option:checked')).toHaveText('草稿中的修改')
  })

  test('本机窗口直接显示编辑器而无需令牌', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '名称', exact: true })).toBeEditable()
  })

  test('本机可信窗口仍拒绝无效预设并给出字段问题', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    const rejected = await invoke(page, 'savePreset', {
      id: 'e2e/invalid',
      profile: { kind: 'hud-style-pack', schemaVersion: 1, id: 'e2e/invalid' } as HudStylePack,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('Invalid profile was unexpectedly written')
    expect(rejected.code).toBe('invalid-profile')
    expect(rejected.detail).toHaveProperty('issues')
    expect((await invoke(page, 'getPreset', { id: 'e2e/invalid' })).ok).toBe(false)
  })

  test('刷新后编辑器仍可用且地址中没有令牌', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('token')).toBe(false)
    await page.reload()
    await expect(page.locator('.editor-main')).toBeVisible()
    expect(new URL(page.url()).searchParams.has('token')).toBe(false)
  })

  test('进入编辑器再返回, 已载入的两路片源和播放状态保留', async ({ page }) => {
    test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')
    failOnPageError(page)
    await openPlayer(page)
    await loadBothFixtures(page)
    await setPlaying(page, true)
    const before = await mediaTimes(page)

    const settings = await openSettingsSection(page, '倒计时样式')
    await settings.getByRole('link', { name: '打开倒计时样式编辑器' }).click()
    await expect(page.locator('.editor-main')).toBeVisible()
    await page.getByRole('link', { name: '返回播放器' }).click()

    await expect(page.locator('.studio:not(.editor)')).toBeVisible()
    await expect(sourceDialog(page)).toBeHidden()
    for (const role of ['official', 'commentary'] as const) {
      await expect(page.locator(`.chip[data-role="${role}"]`)).toHaveAttribute('data-status', 'ready')
    }
    await expect.poll(async () => (await mediaTimes(page)).paused, { timeout: 15_000 }).toBe(false)
    const after = await mediaTimes(page)
    // The same elements kept playing their sources: no reload restarted them from zero.
    expect(after.official).toBeGreaterThanOrEqual(before.official)
  })

  test('返回播放器后仍可在同一本机窗口进入编辑器', async ({ page }) => {
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()
    await page.getByRole('link', { name: '返回播放器' }).click()
    await expect(page.locator('.studio')).toBeVisible()
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()
  })
})

test.describe('取帧与切分', () => {
  test.skip(!fixturesReady(), '缺少测试源，先运行 npm run fixtures')

  test('前后一帧按文件真实的帧走', async ({ page, electronApp }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(electronApp, page, officialPath)
    const video = page.locator('video.editor-media')
    await expect.poll(async () => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)
    // Sampling cadence is owned by the player now; file stepping still follows all 30 fps.
    await page.locator('details.rail-more > summary').click()
    await expect(page.getByRole('slider', { name: '采样帧率' })).toHaveCount(0)
    await seekSample(page, 1)
    // Every frame the page presents, in order: what each click actually lands on.
    await video.evaluate((node: HTMLVideoElement) => {
      const seen: number[] = []
      ;(window as unknown as { __frames: number[] }).__frames = seen
      const watch = () => node.requestVideoFrameCallback((_now, meta) => { seen.push(meta.mediaTime); watch() })
      watch()
    })
    const landed = async (press: () => Promise<void>): Promise<number> => {
      const count = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.length)
      await press()
      await expect.poll(async () => page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.length)).toBeGreaterThan(count)
      // A step may nudge more than once; wait for it to settle on the frame it keeps.
      await page.waitForTimeout(400)
      return page.evaluate(() => { const f = (window as unknown as { __frames: number[] }).__frames; return f[f.length - 1]! })
    }
    const nudge = await landed(async () => { await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 1.01 }) })
    const visits: number[] = [nudge]
    for (let i = 0; i < 10; i++) visits.push(await landed(() => page.getByRole('button', { name: '下一帧' }).click()))
    for (let i = 0; i < 4; i++) visits.push(await landed(() => page.getByRole('button', { name: '上一帧' }).click()))
    const frame = (time: number) => Math.round(time * 30)
    const indices = visits.map(frame)
    // One real frame per press, forward then back, never a repeat or a skip.
    expect(indices.slice(1, 11).map((index, i) => index - indices[i]!)).toEqual(Array(10).fill(1))
    expect(indices.slice(11).map((index, i) => index - indices[10 + i]!)).toEqual(Array(4).fill(-1))
    await page.getByRole('button', { name: '放大到当前框', exact: true }).click()
    const zoomedFrame = await landed(() => page.getByRole('button', { name: '下一帧' }).click())
    expect(frame(zoomedFrame)).toBe(indices.at(-1)! + 1)
    const zoomedBack = await landed(() => page.getByRole('button', { name: '上一帧' }).click())
    expect(frame(zoomedBack)).toBe(indices.at(-1)!)
    await page.locator('.editor-stage').focus()
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(false)
    await page.keyboard.press('Space')
    await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true)

    // Whole-second jumps, by button and by Shift / Ctrl + arrow, stay inside the 26 s file.
    const at = () => video.evaluate((node: HTMLVideoElement) => node.currentTime)
    const jumpTo = async (press: () => Promise<void>, expected: number): Promise<void> => {
      await press()
      await expect.poll(at).toBeCloseTo(expected, 1)
      await expect.poll(() => video.evaluate((node: HTMLVideoElement) => node.seeking)).toBe(false)
    }
    await video.evaluate((node: HTMLVideoElement) => { node.currentTime = 5 })
    await expect.poll(at).toBeCloseTo(5, 1)
    await jumpTo(() => page.getByRole('button', { name: '+1s', exact: true }).click(), 6)
    await jumpTo(() => page.getByRole('button', { name: '+10s', exact: true }).click(), 16)
    await jumpTo(() => page.getByRole('button', { name: '-1s', exact: true }).click(), 15)
    await page.locator('.editor-stage').focus()
    await jumpTo(() => page.keyboard.press('Shift+ArrowRight'), 16)
    await jumpTo(() => page.keyboard.press('Control+ArrowLeft'), 6)
    await jumpTo(() => page.keyboard.press('Control+ArrowLeft'), 0)
    await jumpTo(() => page.getByRole('button', { name: '+10s', exact: true }).click(), 10)
    await jumpTo(() => page.getByRole('button', { name: '+10s', exact: true }).click(), 20)
    await jumpTo(() => page.getByRole('button', { name: '+10s', exact: true }).click(), 26)
    expect(await video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true)
  })

  test('载入样片后取帧并切出字符框', async ({ page, electronApp }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()

    await chooseEditorVideo(electronApp, page, officialPath)
    const video = page.locator('video.editor-media')
    await expect(video).toBeVisible()
    await expect.poll(async () => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)

    // Point the ROI at the countdown the fixture generator drew, then grab.
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await seekSample(page, 1)
    await page.getByRole('button', { name: '取当前帧' }).click()

    // Both previews come from the same analysis, so a mask means segmentation ran.
    await expect(page.locator('.crop-canvas').first()).toBeVisible()
    // 0:19 at t=1s — four glyphs.
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
    const crop = page.locator('.crop-canvas').first()
    const nativePreview = await crop.evaluate((node: HTMLCanvasElement) => node.toDataURL())
    const time = await video.evaluate((node: HTMLVideoElement) => node.currentTime)
    await page.getByRole('button', { name: '放大到当前框', exact: true }).click()
    await expect(page.locator('.editor-stage')).toHaveClass(/is-zoomed/)
    await page.getByRole('button', { name: '取当前帧' }).click()
    await expect.poll(() => page.locator('.glyph-box').count()).toBe(4)
    await expect.poll(() => crop.evaluate((node: HTMLCanvasElement) => node.toDataURL())).toBe(nativePreview)
    expect(await video.evaluate((node: HTMLVideoElement) => node.currentTime)).toBe(time)
  })

  test('点字符按钮把选中的框存成模板样本', async ({ page, electronApp }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(electronApp, page, officialPath)
    await expect.poll(async () =>
      page.locator('video.editor-media').evaluate((node: HTMLVideoElement) => node.videoWidth),
    ).toBeGreaterThan(0)
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await seekSample(page, 1)
    await page.getByRole('button', { name: '取当前帧' }).click()
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThan(0)

    const emptyBefore = await page.locator('.template-cell.is-empty').count()
    // The leftmost box is selected as soon as the frame is cut, so the reading can be typed at once.
    await expect(page.locator('.glyph-box').first()).toHaveClass(/is-selected/)
    // 0:19 reads 0, :, 1, 9 left to right; the pad auto-advances, so one click per glyph.
    for (const char of ['0', ':', '1', '9']) {
      await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
    }

    await expect(page.locator('.editor-rail')).toContainText('4 个样本')
    expect(await page.locator('.template-cell.is-empty').count()).toBeLessThan(emptyBefore)
  })

  test('整段扫描按每秒减 1 提议读数, 勾选后一次存入, 相同字形只存一次', async ({ page, electronApp }) => {
    test.setTimeout(120_000)
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(electronApp, page, officialPath)
    const video = page.locator('video.editor-media')
    await expect.poll(async () => video.evaluate((node: HTMLVideoElement) => node.videoWidth)).toBeGreaterThan(0)
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    const section = page.getByRole('region', { name: '整段标注' })
    await page.getByRole('button', { name: '放大到当前框', exact: true }).click()

    // 1.0 s shows 0:19 (see the single-frame test); mark 1.0 to 4.2 s.
    await seekSample(page, 1)
    await section.getByRole('button', { name: /设为入点/ }).click()
    await seekSample(page, 4.2)
    await section.getByRole('button', { name: /设为出点/ }).click()
    await section.getByRole('textbox', { name: '入点读数' }).fill('0:19')
    await section.getByRole('button', { name: '扫描这一段' }).click()

    const results = section.getByRole('list', { name: '扫描结果' })
    await expect(results).toBeVisible({ timeout: 60_000 })
    const readings = await results.getByRole('textbox').evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value))
    // Counted down one per change; every whole second in the stretch is there.
    expect(readings.filter(Boolean).slice(0, 4)).toEqual(['0:19', '0:18', '0:17', '0:16'])
    const save = section.getByRole('button', { name: /存入勾选的/ })
    await save.click()
    await expect(results).toBeHidden()
    await expect(page.locator('.editor-message, .editor-note').first()).toContainText('相同的字形只存一次')
    // 0:19..0:15 uses 0 : 1 9 8 7 6 5: each character at least once, far fewer samples than frames.
    for (const char of ['0', ':', '1', '9', '8', '7', '6']) {
      await expect(page.locator('.template-cell').filter({ has: page.locator('.template-char', { hasText: new RegExp(`^${char}$`) }) })
        .locator('.template-thumb').first()).toBeVisible()
    }
    const total = await page.locator('.template-thumb').count()
    expect(total).toBeLessThan(40)
  })

  test('字符按钮即点即存, 整帧读数只读且同一帧不重复保存', async ({ page, electronApp }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await chooseEditorVideo(electronApp, page, officialPath)
    await expect.poll(async () =>
      page.locator('video.editor-media').evaluate((node: HTMLVideoElement) => node.videoWidth),
    ).toBeGreaterThan(0)
    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await seekSample(page, 1)
    await page.getByRole('button', { name: '取当前帧' }).click()
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBe(4)

    await expect(page.getByRole('textbox', { name: '整帧读数' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '存为样本', exact: true })).toHaveCount(0)
    const reading = page.getByLabel('当前读数', { exact: true })
    for (const [index, char] of ['0', ':', '1', '9'].entries()) {
      await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
      await expect(page.locator('.template-thumb')).toHaveCount(index + 1)
    }
    await expect(reading).toHaveText('0:19')
    await page.getByRole('button', { name: '取当前帧' }).click()
    await expect(page.locator('.glyph-box')).toHaveCount(4)
    for (const char of ['0', ':', '1', '9']) await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
    await expect(page.locator('.template-thumb')).toHaveCount(4)
    for (const char of ['0', ':', '1', '9']) {
      await expect(page.locator('.template-cell').filter({ has: page.locator('.template-char', { hasText: new RegExp(`^${char}$`) }) })
        .locator('.template-thumb')).toHaveCount(1)
    }
  })
})

test.describe('发布预设', () => {
  test('比分字段各自制作字形, 切换后验证当前帧并保留各自样本', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const context = canvas.getContext('2d')!
      context.fillStyle = '#000'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#fff'
      // Integer blocks avoid platform font rasterization; 96 px normalizes exactly to 48.
      const glyphs: Record<string, string[]> = {
        '1': ['00100', '01100', '00100', '00100', '00100', '00100', '00100', '11111'],
        '8': ['01110', '11011', '11011', '01110', '11011', '11011', '11011', '01110'],
        '7': ['11111', '00011', '00010', '00110', '00100', '01100', '01000', '11000'],
      }
      for (const [text, start] of [['18', 420], ['7', 760]] as const) {
        for (const [index, char] of [...text].entries()) {
          glyphs[char]!.forEach((row, y) => [...row].forEach((pixel, x) => {
            if (pixel === '1') context.fillRect(start + index * 72 + x * 12, 90 + y * 12, 12, 12)
          }))
        }
      }
      return canvas.toDataURL('image/png').split(',')[1]!
    })
    await page.locator('main input[accept^="image/"]').setInputFiles({
      name: 'scores.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
    })
    await expect(page.locator('img.editor-media')).toBeVisible()
    const field = page.getByRole('combobox', { name: '当前字段', exact: true })

    for (const score of [
      { id: 'scoreLeft', text: '18', x: 400, width: 200, samples: 2 },
      { id: 'scoreRight', text: '7', x: 740, width: 140, samples: 1 },
    ]) {
      await field.selectOption(score.id)
      await setRoi(page, { x: score.x / 1280, y: 70 / 720, w: score.width / 1280, h: 140 / 720 })
      await expect.poll(async () => page.locator('.glyph-box').count()).toBe(score.text.length)
      await expect(page.locator('.template-thumb')).toHaveCount(0)
      await expect(page.locator('.char-pad').getByRole('button', { name: ':', exact: true })).toHaveCount(0)
      for (const char of score.text) await page.locator('.char-pad').getByRole('button', { name: char, exact: true }).click()
      await expect(page.locator('.template-thumb')).toHaveCount(score.samples)
      await page.getByRole('button', { name: '验证当前帧', exact: true }).click()
      await expect(page.locator('.verify-result')).toContainText(`识别为 ${score.text}`)
    }

    await field.selectOption('scoreLeft')
    await expect(page.locator('.template-thumb')).toHaveCount(2)
    await page.getByRole('button', { name: '验证当前帧', exact: true }).click()
    await expect(page.locator('.verify-result')).toContainText('识别为 18')
    await field.selectOption('clock')
    await expect(page.locator('.template-thumb')).toHaveCount(0)
    await expect(page.locator('.char-pad').getByRole('button', { name: ':', exact: true })).toBeVisible()
  })

  test('新样式包导出实际文件后能重新导入并保留所有布局和字段', async ({ page, electronApp }, testInfo) => {
    failOnPageError(page)
    const profile = baseProfile('e2e/export-roundtrip')
    const clock = profile.variants[0]!.fields.clock!
    profile.bitmaps.sample = { width: 32, height: 48,
      data: packBitmap(Uint8Array.from({ length: TEMPLATE_PIXELS }, (_, index) => index % 7 === 0 ? 255 : 0)) }
    clock.glyphs['1'] = ['sample']
    profile.variants[0]!.fields.scoreLeft = { ...structuredClone(clock), grammar: { kind: 'integer', min: 0, max: 99 } }
    profile.variants[0]!.organizer = { roi: { x: 0, y: 0, w: 32, h: 48 },
      preprocess: { ...clock.preprocess }, templates: ['sample'], minScore: 0.9 }
    profile.variants[0]!.states['has-clock'] = [[{ kind: 'field', field: 'clock', present: true }]]
    profile.variants.push({ ...structuredClone(profile.variants[0]!), id: 'official-bottom-1080' })
    expect((await invoke(page, 'savePreset', { id: profile.id, profile })).ok).toBe(true)
    await page.goto(APP_ORIGIN + '/admin')
    await openLibrary(page)
    await page.locator('.library-item').filter({ hasText: profile.id }).first().click()
    await expect(page.locator('.editor-note')).toContainText('已载入预设')

    const target = testInfo.outputPath('export-roundtrip.json')
    await mkdir(dirname(target), { recursive: true })
    await electronApp.evaluate(({ session }, savePath) => {
      const state = globalThis as typeof globalThis & { __hudPackDownload?: Promise<{ state: string; filename: string; path: string }> }
      state.__hudPackDownload = new Promise(resolve => {
        session.defaultSession.once('will-download', (_event, item) => {
          // DownloadItem needs the native absolute Windows path supplied by outputPath.
          item.setSavePath(savePath)
          item.once('done', (_done, outcome) => resolve({ state: outcome, filename: item.getFilename(), path: item.getSavePath() }))
        })
      })
    }, target)
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '导出 JSON', exact: true }).click()
    const download = await electronApp.evaluate(() => (globalThis as typeof globalThis & {
      __hudPackDownload: Promise<{ state: string; filename: string; path: string }>
    }).__hudPackDownload)
    expect(download).toEqual({ state: 'completed', filename: 'e2e-export-roundtrip.json', path: target })
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(profile)

    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('button', { name: '新建空白样式', exact: true }).click()
    await page.getByLabel('导入 JSON', { exact: true }).setInputFiles(target)
    await expect(page.locator('.editor-note')).toContainText('已导入')
    await page.getByRole('button', { name: '发布到本机', exact: true }).click()
    await expect(page.locator('.editor-note')).toContainText('已发布为本机预设')
    const fetched = await invoke(page, 'getPreset', { id: profile.id })
    expect(fetched.ok && fetched.value.profile).toEqual(profile)
  })

  test('发布后可以通过接口读回，并带 etag', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()

    const id = `e2e/publish-${Date.now()}`
    await setField(page, '标识', id)
    await setField(page, '名称', 'E2E 发布测试')
    await page.getByRole('button', { name: '发布到本机' }).click()
    await expect(page.locator('.editor-note.is-info')).toContainText('已发布')

    const fetched = await invoke(page, 'getPreset', { id })
    expect(fetched.ok).toBe(true)
    if (!fetched.ok) throw new Error(fetched.message)
    const body = fetched.value
    expect(body.profile.id).toBe(id)
    expect(body.profile.name).toBe('E2E 发布测试')
    expect(body.etag).toBeTruthy()

    // It also shows up in the library listing the editor reads on load.
    const list = await invoke(page, 'listPresets', undefined)
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error(list.message)
    expect(list.value.presets.some((preset) => preset.id === id)).toBe(true)
  })

  test('别的会话改动过预设时发布被拒绝', async ({ page }) => {
    failOnPageError(page)
    const id = `e2e/conflict-${Date.now()}`

    // Seed through the actual preload so the editor loads the stored ETag.
    const seed = await invoke(page, 'savePreset', { id, profile: { ...baseProfile(id), name: '初始版本' } })
    expect(seed.ok).toBe(true)

    await page.goto(APP_ORIGIN + '/admin')
    await openLibrary(page)
    await page.locator('.library-item').filter({ hasText: id }).first().click()
    await expect(page.locator('.editor-note')).toContainText('已载入预设')

    // A third party writes in between, which moves the etag out from under the editor.
    const interleaved = await invoke(page, 'savePreset', { id, profile: { ...baseProfile(id), name: '别人的版本' } })
    expect(interleaved.ok).toBe(true)

    await setField(page, '名称', '我的版本')
    await page.getByRole('button', { name: '发布到本机' }).click()
    // Last-write-wins would silently discard the other session's edit.
    await expect(page.locator('.editor-note.is-error')).toContainText('已在别处被修改')

    const after = await invoke(page, 'getPreset', { id })
    expect(after.ok).toBe(true)
    if (!after.ok) throw new Error(after.message)
    const body = after.value
    expect(body.profile.name).toBe('别人的版本')

    // Overwriting is a deliberate, named choice and then wins against that version.
    await page.getByRole('button', { name: '用我的版本覆盖' }).click()
    await expect(page.locator('.editor-note.is-info')).toContainText('已发布为本机预设')
    const overwritten = await invoke(page, 'getPreset', { id })
    expect(overwritten.ok && overwritten.value.profile.name).toBe('我的版本')
  })

  test('截图样片可选择也可粘贴，并切出字符框', async ({ page }) => {
    test.skip(!fixturesReady(), '需要先运行 npm run fixtures')
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await expect(page.locator('.editor-main')).toBeVisible()

    await setRoi(page, { x: 0.42, y: 0.045, w: 0.16, h: 0.13 })
    await page.locator('main input[accept^="image/"]').setInputFiles(framePath)
    await expect(page.locator('img.editor-media')).toBeVisible()
    await expect(page.locator('.editor-note')).toContainText('1280×720')
    // The still is the frame: no grabbing, and 0:20 segments into its glyphs.
    await expect(page.getByRole('button', { name: '取当前帧' })).toHaveCount(0)
    await expect.poll(async () => page.locator('.glyph-box').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3)

    // Paste the same picture through a real ClipboardEvent carrying a File.
    const bytes = [...await (await import('node:fs/promises')).readFile(framePath)]
    await page.evaluate((data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'clip.png', { type: 'image/png' }))
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }))
    }, bytes)
    await expect(page.locator('.editor-note')).toContainText('粘贴的截图')

    // An unsupported image is refused with a reason rather than silently ignored.
    await page.locator('main input[accept^="image/"]').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
    await expect(page.locator('.editor-note.is-error')).toContainText('只支持 PNG、JPEG 或 WebP')
  })
})

test.describe('YouTube 录像素材', () => {
  test('编辑器能切到 YouTube 录像并经主进程打开链接, 离线时说明原因', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    await page.getByRole('radiogroup', { name: '素材来源' }).getByText('YouTube 录像').click()
    const panel = page.getByRole('region', { name: 'YouTube 录像' })
    await expect(panel).toBeVisible()
    await panel.getByRole('textbox', { name: 'YouTube 录像链接' }).fill('https://youtu.be/swMquqtyh-A')
    await panel.getByRole('button', { name: '打开', exact: true }).click()
    // Offline e2e refuses network in main, so this proves the request reached main and came back.
    await expect(panel.getByRole('alert')).toContainText('连不上 YouTube')
    // Clip downloads are listed through main as well; none have run here.
    await expect(panel.getByRole('list', { name: '下载' })).toHaveCount(0)
    await page.getByRole('radiogroup', { name: '素材来源' }).getByText('本地文件').click()
    await expect(panel).toBeHidden()
  })

  test('片段下载接口只接受三种数字画质, 离线时不启动下载', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    const request = { url: 'https://www.youtube.com/watch?v=abcdefghijk', startSeconds: 0, endSeconds: 20 }
    const call = (args: unknown) => page.evaluate((value) => window.streamSyncer!.invoke('ytImportStart', value as never), args)
    expect(await call(request)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    for (const targetHeight of [720, 4320, 1440.5, '2160', null]) {
      expect(await call({ ...request, targetHeight })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    }
    for (const targetHeight of [2160, 1440, 1080]) {
      expect(await call({ ...request, targetHeight })).toMatchObject({ ok: false, code: 'network' })
    }
  })

  test('播放器位置接口只收严格参数', async ({ page }) => {
    failOnPageError(page)
    await page.goto(APP_ORIGIN + '/admin')
    const call = (args: unknown) => page.evaluate((value) => window.streamSyncer!.invoke('ytBrowseSetViewport', value as never), args)
    expect(await call({ rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true })).toMatchObject({ ok: true })
    expect(await call({ rect: { x: 10, y: 20, width: 640, height: 360 }, visible: true, extra: 1 })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await call({ rect: { x: 10, y: 20, width: -1, height: 360 }, visible: true })).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(await call({ rect: { x: 10, y: 20, width: 640, height: 360 }, visible: 'yes' })).toMatchObject({ ok: false, code: 'invalid-arguments' })
  })
})

/** A minimal valid profile for seeding through the API. */
function baseProfile(id: string): HudStylePack {
  return createEmptyHudStylePack(id, '种子预设')
}

/** Fill one of the top bar's two fields, named 名称 and 标识. */
async function setField(page: Page, label: string, value: string): Promise<void> {
  await page.getByRole('textbox', { name: label, exact: true }).fill(value)
}

/** Open the top bar's 打开 menu, where presets and drafts are listed. */
async function openLibrary(page: Page): Promise<void> {
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '打开' })).toBeVisible()
}

/** The four ROI inputs render in a fixed order: x, y, w, h. */
async function setRoi(page: Page, roi: { x: number; y: number; w: number; h: number }): Promise<void> {
  const inputs = page.locator('.roi-field input')
  for (const [index, value] of [roi.x, roi.y, roi.w, roi.h].entries()) {
    await inputs.nth(index).fill(String(value))
  }
}

/** Seek the sample element directly; the editor grabs on `seeked`. */
async function seekSample(page: Page, seconds: number): Promise<void> {
  await page.locator('video.editor-media').evaluate((node: HTMLVideoElement, to: number) => {
    node.currentTime = to
  }, seconds)
  await page.waitForTimeout(500)
}
