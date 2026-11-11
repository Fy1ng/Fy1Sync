/** Browser font rasterization exercises the production Worker without fixture-specific templates. */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN, expect, test } from './electron'
import { openPlayer } from './helpers'

test('真实系统字体跨位置识别, 排除相邻比分并拒绝双时钟和静止画面', async ({ page }) => {
  test.setTimeout(120_000)
  await openPlayer(page)
  const assets = readdirSync(fileURLToPath(new URL('../dist/client/assets/', import.meta.url)))
  const workerAsset = assets.find(name => /^recognition\.worker-.*\.js$/.test(name))
  expect(workerAsset).toBeTruthy()
  const report = await page.evaluate(async ({ workerUrl }) => {
    const worker = new Worker(workerUrl, { type: 'module' })
    let pending: ((value: any) => void) | null = null
    worker.onmessage = event => { const resolve = pending; pending = null; resolve?.(event.data) }
    const ask = (message: unknown, transfer: Transferable[] = []): Promise<any> => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending = null; reject(new Error('基础识别 Worker 超时')) }, 10_000)
      pending = value => { clearTimeout(timeout); resolve(value) }
      worker.postMessage(message, transfer)
    })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const scenarios = [
      { name: 'arial-lower', width: 1280, height: 720, x: 450, y: 360, size: 64, font: '700 64px Arial', start: 83 },
      { name: 'segoe-left', width: 960, height: 540, x: 160, y: 80, size: 60, font: '400 60px "Segoe UI"', start: 83 },
      { name: 'consolas-minute', width: 1280, height: 720, x: 470, y: 100, size: 72, font: '400 72px Consolas', start: 61 },
      { name: 'two-clocks', width: 1280, height: 720, x: 300, y: 90, size: 64, font: '700 64px Arial', start: 83, second: true },
      { name: 'frozen', width: 960, height: 540, x: 300, y: 90, size: 64, font: '700 64px Arial', start: 83, frozen: true },
    ]
    const results: { name: string; successes: number; text?: string; roi?: { x: number; y: number; w: number; h: number }; statuses: string[] }[] = []
    try {
      for (let index = 0; index < scenarios.length; index++) {
        const scenario = scenarios[index]!
        const generation = index + 1
        await ask({ type: 'configure', generation, profile: { kind: 'basic-clock', id: 'basic-clock', name: '基础模式', sampleFps: 15 } })
        canvas.width = scenario.width
        canvas.height = scenario.height
        let successes = 0
        let text: string | undefined
        let roi: { x: number; y: number; w: number; h: number } | undefined
        const statuses = new Set<string>()
        for (let frame = 0; frame <= 54; frame++) {
          const mediaTime = frame / 15
          const seconds = scenario.start - (scenario.frozen ? 0 : Math.floor(mediaTime))
          const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
          context.fillStyle = '#10151b'
          context.fillRect(0, 0, canvas.width, canvas.height)
          context.font = scenario.font
          context.textBaseline = 'top'
          context.fillStyle = '#f2f5f7'
          context.fillText('12', scenario.x - scenario.size * 2.4, scenario.y)
          context.fillText(clock, scenario.x, scenario.y)
          context.fillText('9', scenario.x + context.measureText(clock).width + scenario.size * 0.8, scenario.y)
          if (scenario.second) context.fillText(clock, 800, 400)
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data.buffer
          const result = await ask({ type: 'frame', generation, role: 'official', frameIndex: frame + 1,
            mediaTime, wallTime: 1000 + mediaTime * 1000, width: canvas.width, height: canvas.height, pixels, wantDebug: false }, [pixels])
          if (result.type === 'error') throw new Error(result.message)
          if (result.basic?.status) statuses.add(result.basic.status)
          if (result.outcome?.status === 'success') { successes++; text = result.outcome.reading.text; roi = result.basic?.roi }
        }
        results.push({ name: scenario.name, successes, text, roi, statuses: [...statuses] })
      }
      return results
    } finally { worker.terminate() }
  }, { workerUrl: `${APP_ORIGIN}/assets/${workerAsset}` })
  await test.info().attach('basic-clock-browser-fonts', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
  for (const result of report.slice(0, 3)) {
    expect(result.successes, JSON.stringify(result)).toBeGreaterThan(0)
    expect(result.roi, JSON.stringify(result)).toBeDefined()
    // The clock crop must exclude the deliberately adjacent scoreboard numbers.
    expect(result.roi!.w).toBeLessThan(0.25)
    expect(result.roi!.h).toBeLessThan(0.2)
  }
  for (const result of report.slice(3)) expect(result.successes, JSON.stringify(result)).toBe(0)
})
