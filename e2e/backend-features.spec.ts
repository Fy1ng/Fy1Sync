import { test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { expect, launchApplication } from './electron'

test('backend feature settings and favorites persist through a real Electron restart', async () => {
  const running = await launchApplication('backend-preferences')
  try {
    const result = await running.page.evaluate(async () => {
      const api = window.streamSyncer!
      const initial = await api.invoke('getDanmakuFeatures', undefined)
      const changed = await api.invoke('setDanmakuPreferences', { verticalGapPx: 18, duplicateMode: 'combo', showUserDetails: true })
      const favorite = await api.invoke('addDanmakuFavorite', { text: 'SYNTHETIC_BACKEND_FAVORITE', room: '100', uid: '42' })
      const update = await api.invoke('getAppUpdateState', undefined)
      const disabled = await api.invoke('getCaptureState', undefined)
      const automation = await api.invoke('createDouyuAutomation', { accountId: 'default', kind: 'client-sign',
        target: { type: 'account' }, options: {}, policy: 'foreground', repeatMinutes: null })
      return { initial, changed, favorite, update, disabled, automation }
    })
    expect(result.initial).toMatchObject({ ok: true, value: { preferences: { showUserDetails: false } } })
    expect(result.changed).toMatchObject({ ok: true, value: { preferences: { verticalGapPx: 18, duplicateMode: 'combo' } } })
    expect(result.favorite.ok).toBe(true)
    expect(result.update).toMatchObject({ ok: true, value: { phase: 'unconfigured' } })
    expect(result.disabled).toMatchObject({ ok: true, value: { settings: { enabled: false } } })
    expect(result.automation).toMatchObject({ ok: true, value: { tasks: [{ kind: 'client-sign', status: 'paused' }] } })
    await running.restart()
    const restored = await running.page.evaluate(async () => ({
      settings: await window.streamSyncer!.invoke('getDanmakuFeatures', undefined),
      favorites: await window.streamSyncer!.invoke('queryDanmakuFavorites', { query: 'BACKEND_FAVORITE' }),
      automations: await window.streamSyncer!.invoke('getDouyuAutomations', undefined),
    }))
    expect(restored.settings).toMatchObject({ ok: true, value: { preferences: { verticalGapPx: 18, showUserDetails: true }, favoriteCount: 1 } })
    expect(restored.favorites).toMatchObject({ ok: true, value: { total: 1 } })
    expect(restored.automations).toMatchObject({ ok: true, value: { tasks: [{ kind: 'client-sign', status: 'paused' }] } })
  } finally { await running.close() }
})

test('three independent streams preserve the synchronization source and restricted PiP audio ownership', async () => {
  const running = await launchApplication('backend-streams')
  try {
    const opened = await running.page.evaluate(async () => {
      const api = window.streamSyncer!
      const base = await api.invoke('resolve', { input: '/test-sources/official.mp4', role: 'official' })
      const sessions = await Promise.all([1, 2, 3].map(() => api.invoke('openStreamSession', { input: '/test-sources/commentary.mp4' })))
      return { base, sessions }
    })
    expect(opened.base).toMatchObject({ ok: true, value: { ok: true } })
    expect(opened.sessions.every(item => item.ok && item.value.phase === 'ready')).toBe(true)
    const first = opened.sessions[0]!
    if (!first.ok) throw new Error('Session creation failed')
    const id = first.value.id
    const checked = await running.page.evaluate(async id => {
      const api = window.streamSyncer!
      const closed = await api.invoke('closeStreamSession', { id })
      const base = await api.invoke('getStreamPlayback', { id: 'official' })
      return { closed, base }
    }, id)
    expect(checked.closed).toMatchObject({ ok: true, value: { sessions: [{ phase: 'ready' }, { phase: 'ready' }] } })
    expect(checked.base).toMatchObject({ ok: true, value: { url: '/test-sources/official.mp4' } })
    const nextWindow = running.application.waitForEvent('window')
    const pip = await running.page.evaluate(() => window.streamSyncer!.invoke('openEnhancedPip', { id: 'official', options: { lowPower: true } }))
    expect(pip).toMatchObject({ ok: true, value: { phase: 'opening', sendContext: { canAttempt: false } } })
    const floating = await nextWindow
    await floating.waitForURL('app://app/pip')
    const denied = await floating.evaluate(() => window.streamSyncer!.invoke('getDouyuTasks', undefined))
    expect(denied).toMatchObject({ ok: false, code: 'forbidden' })
    const ready = await floating.evaluate(() => window.streamSyncer!.invoke('reportEnhancedPip', { ready: true, playing: false, mediaTime: 0, frameCount: 0 }))
    expect(ready).toMatchObject({ ok: true, value: { audioOwner: 'pip' } })
    const ownership = await running.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({
      path: new URL(win.webContents.getURL()).pathname, muted: win.webContents.isAudioMuted(), throttle: win.webContents.backgroundThrottling,
    })))
    expect(ownership.find(item => item.path === '/')).toMatchObject({ muted: true, throttle: true })
    expect(ownership.find(item => item.path === '/pip')).toMatchObject({ muted: false })
    const closed = await running.page.evaluate(() => window.streamSyncer!.invoke('closeEnhancedPip', undefined))
    expect(closed).toMatchObject({ ok: true, value: { phase: 'closed', audioOwner: 'main' } })
    expect(await running.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isAudioMuted())).toBe(false)
  } finally { await running.close() }
})

test('opt-in screenshot and GIF use real native image validation and bundled ffmpeg through IPC', async () => {
  const running = await launchApplication('backend-capture')
  try {
    await running.application.evaluate(({ app, dialog }) => {
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { filters?: Array<{ extensions: string[] }> }
        const extension = options.filters?.[0]?.extensions[0] ?? 'png'
        return { canceled: false, filePath: app.getPath('userData') + '/backend-test.' + extension }
      }
    })
    const png = await running.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32
      const context = canvas.getContext('2d')!; context.fillStyle = 'red'; context.fillRect(0, 0, 32, 32)
      return canvas.toDataURL('image/png')
    })
    const results = await running.page.evaluate(async png => {
      const api = window.streamSyncer!
      const denied = await api.invoke('savePlaybackScreenshot', { png })
      const enabled = await api.invoke('setCaptureEnabled', { enabled: true })
      const screenshot = await api.invoke('savePlaybackScreenshot', { png })
      const started = await api.invoke('beginGifRecording', { fps: 2, seconds: 1, width: 160 })
      if (!started.ok) return { denied, enabled, screenshot, started }
      const one = await api.invoke('appendGifFrame', { id: started.value.id, index: 0, png })
      const two = await api.invoke('appendGifFrame', { id: started.value.id, index: 1, png })
      const gif = await api.invoke('finishGifRecording', { id: started.value.id })
      const disabled = await api.invoke('setCaptureEnabled', { enabled: false })
      return { denied, enabled, screenshot, started, one, two, gif, disabled }
    }, png)
    expect(results.denied).toMatchObject({ ok: false, code: 'disabled' })
    expect(results.screenshot).toMatchObject({ ok: true, value: { status: 'saved' } })
    expect(results.gif).toMatchObject({ ok: true, value: { status: 'saved' } })
    expect(results.disabled).toMatchObject({ ok: true, value: { settings: { enabled: false }, recordings: [] } })
    const pngSize = await running.application.evaluate(({ app, nativeImage }) =>
      nativeImage.createFromPath(app.getPath('userData') + '/backend-test.png').getSize())
    expect(pngSize).toEqual({ width: 32, height: 32 })
    if (!results.gif?.ok || !results.gif.value.path) throw new Error('GIF export path unavailable')
    const gif = (await readFile(results.gif.value.path)).toString('base64')
    // NativeImage supports PNG/JPEG, so decode the exported GIF using Chromium itself.
    const dimensions = await running.page.evaluate(base64 => new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error('Exported GIF did not decode'))
      image.src = 'data:image/gif;base64,' + base64
    }), gif)
    expect(dimensions).toEqual({ width: 160, height: 160 })
  } finally { await running.close() }
})
