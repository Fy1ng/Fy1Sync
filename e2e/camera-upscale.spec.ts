import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { UpscaleDiagnostics } from '../src/media/upscale/renderer'
import { expect, test } from './electron'
import { fixturesReady, loadBothFixtures, openCameraFraming, openPlayer, revealOverlay, setCheckedByLabel } from './helpers'

const evidence = path.resolve('.runtime-cache/s2-camera-upscale/gpu-e2e')

async function frameCamera(page: Page): Promise<void> {
  await openCameraFraming(page)
  await page.getByRole('dialog', { name: '摄像头小窗', exact: true }).getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.camera-overlay')).toBeVisible()
}

async function selectTier(page: Page, label: string): Promise<void> {
  await revealOverlay(page)
  await page.waitForTimeout(150)
  const trigger = page.locator('.dock').getByRole('button', { name: '主播摄像头', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  await setCheckedByLabel(page.getByRole('radiogroup', { name: '摄像头超分' }).getByRole('radio', { name: label, exact: true }))
  await page.keyboard.press('Escape')
}

test.describe('摄像头超分', () => {
  test.skip(!fixturesReady(), '缺少本地测试源')

  for (const unavailable of ['missing', 'null-adapter', 'device-failed'] as const) {
    test(`WebGPU 不可用时保持原始2D路径: ${unavailable}`, async ({ page }) => {
      await page.addInitScript((kind) => {
        Object.defineProperty(navigator, 'gpu', { configurable: true, value: kind === 'missing' ? undefined : {
          requestAdapter: async () => kind === 'null-adapter' ? null : {
            features: new Set(), requestDevice: async () => { throw new Error('设备不可用') },
          },
        } })
      }, unavailable)
      await openPlayer(page)
      await loadBothFixtures(page)
      await frameCamera(page)
      const overlay = page.locator('.camera-overlay')
      await expect(overlay).toHaveAttribute('data-upscale-reason', 'unsupported')
      await expect(overlay).toHaveAttribute('data-upscale-mode', '2d')
      await expect(overlay.locator('canvas')).toHaveCount(1)
      expect(await overlay.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
        const video = document.querySelector<HTMLVideoElement>('video[data-role="commentary"]')!
        return canvas.width === Math.round(Math.min(video.videoWidth * 0.16, 960)) && Boolean(canvas.getContext('2d'))
      })).toBe(true)
      await revealOverlay(page)
      await page.locator('.dock').getByRole('button', { name: '主播摄像头', exact: true }).click()
      await expect(page.getByRole('radiogroup', { name: '摄像头超分' })).toHaveCount(0)
    })
  }

  test('真实GPU两档读回, 尺寸, 边缘和开关生命周期', async ({ page }, testInfo) => {
    await mkdir(evidence, { recursive: true })
    await openPlayer(page)
    await loadBothFixtures(page)
    await page.evaluate(async () => {
      const video = document.querySelector<HTMLVideoElement>('video[data-role="commentary"]')!
      const source = document.createElement('canvas')
      source.width = 640; source.height = 360
      const ctx = source.getContext('2d')!
      ctx.fillStyle = '#555'; ctx.fillRect(0, 0, 640, 360)
      for (let y = 0; y < 360; y += 9) {
        for (let x = 0; x < 640; x += 11) {
          ctx.fillStyle = (Math.floor(x / 11) + Math.floor(y / 9)) % 2 ? '#dddddd' : '#333333'
          ctx.fillRect(x, y, 7, 5)
        }
      }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
      for (let x = -360; x < 640; x += 19) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 360, 360); ctx.stroke()
      }
      video.srcObject = source.captureStream(30)
      await video.play()
      // Keep the deterministic source alive; every presented frame has the same pixels.
      const windowWithSource = window as unknown as { __s2Source?: HTMLCanvasElement; __s2Timer?: number }
      windowWithSource.__s2Source = source
      windowWithSource.__s2Timer = window.setInterval(() => ctx.fillRect(639, 359, 1, 1), 33)
      await new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()))
    })
    await frameCamera(page)
    const overlay = page.locator('.camera-overlay')
    await expect(overlay).not.toHaveAttribute('data-upscale-reason', 'initializing', { timeout: 30_000 })
    if (await overlay.getAttribute('data-upscale-reason') === 'unsupported') {
      await expect(overlay).toHaveAttribute('data-upscale-mode', '2d')
      await writeFile(path.join(evidence, 'fallback.json'), JSON.stringify({ reason: '默认 Electron 无 WebGPU adapter, 已验证2D回退' }))
      return
    }
    const reports: unknown[] = []
    await selectTier(page, '关')
    await expect(overlay).toHaveAttribute('data-upscale-mode', '2d')
    await overlay.screenshot({ path: path.join(evidence, 'off-overlay.png') })
    for (const [tier, label] of [['performance', '省电'], ['quality', '画质']] as const) {
      await selectTier(page, label)
      await expect(overlay).toHaveAttribute('data-upscale-mode', 'webgpu', { timeout: 30_000 })
      await expect(overlay).toHaveAttribute('data-upscale-tier', tier)
      const report = await overlay.locator('.camera-canvas-gpu').evaluate(async (node: HTMLCanvasElement) => {
        const gpu = node as HTMLCanvasElement & {
          upscaleDiagnostics: UpscaleDiagnostics
          readUpscalePixels(): Promise<{ width: number; height: number; pixels: number[] }>
        }
        const output = await gpu.readUpscalePixels()
        const video = document.querySelector<HTMLVideoElement>('video[data-role="commentary"]')!
        const stored = JSON.parse(localStorage.getItem('stream-sync.camera.v1')!) as Record<string, { crop: { x: number; y: number; w: number; h: number } }>
        const crop = Object.values(stored)[0]!.crop
        const make = (width: number, height: number) => {
          const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
          return canvas
        }
        const reference = make(output.width, output.height)
        reference.getContext('2d')!.drawImage(video, crop.x * video.videoWidth, crop.y * video.videoHeight,
          crop.w * video.videoWidth, crop.h * video.videoHeight, 0, 0, output.width, output.height)
        const rendered = make(output.width, output.height)
        rendered.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(output.pixels), output.width, output.height), 0, 0)
        const smallWidth = Math.round(crop.w * video.videoWidth), smallHeight = Math.round(crop.h * video.videoHeight)
        const down = (source: HTMLCanvasElement) => {
          const small = make(smallWidth, smallHeight)
          small.getContext('2d')!.drawImage(source, 0, 0, smallWidth, smallHeight)
          return small.getContext('2d')!.getImageData(0, 0, smallWidth, smallHeight).data
        }
        const a = down(rendered), b = down(reference)
        let absolute = 0, square = 0
        for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { absolute += Math.abs(a[i]! - b[i]!); square += (a[i]! - b[i]!) ** 2 }
        const gradient = (pixels: ArrayLike<number>) => {
          let energy = 0
          for (let y = 1; y < output.height; y++) for (let x = 1; x < output.width; x++) {
            const p = (y * output.width + x) * 4
            const luma = (i: number) => pixels[i]! * 0.2126 + pixels[i + 1]! * 0.7152 + pixels[i + 2]! * 0.0722
            energy += (luma(p) - luma(p - 4)) ** 2 + (luma(p) - luma(p - output.width * 4)) ** 2
          }
          return energy / ((output.width - 1) * (output.height - 1))
        }
        const bilinear = reference.getContext('2d')!.getImageData(0, 0, output.width, output.height).data
        return {
          diagnostics: gpu.upscaleDiagnostics,
          width: node.width, height: node.height,
          expectedWidth: Math.round(node.clientWidth * devicePixelRatio), expectedHeight: Math.round(node.clientHeight * devicePixelRatio),
          meanAbsoluteDifference: absolute / (a.length * 0.75), psnr: 10 * Math.log10(255 ** 2 / (square / (a.length * 0.75))),
          gradientRatio: gradient(output.pixels) / gradient(bilinear),
          referencePng: reference.toDataURL().split(',')[1]!, outputPng: rendered.toDataURL().split(',')[1]!,
        }
      })
      const { referencePng, outputPng, ...metrics } = report
      reports.push({ tier, ...metrics })
      await writeFile(path.join(evidence, `${tier}-reference.png`), Buffer.from(referencePng, 'base64'))
      await writeFile(path.join(evidence, `${tier}-output.png`), Buffer.from(outputPng, 'base64'))
      await writeFile(path.join(evidence, 'metrics.json'), JSON.stringify(reports, null, 2))
      expect(report.width).toBe(report.expectedWidth)
      expect(report.height).toBe(report.expectedHeight)
      // Native-size downsampling must preserve the source's structure despite sharpening.
      expect(report.meanAbsoluteDifference).toBeLessThan(15)
      expect(report.psnr).toBeGreaterThan(22)
      expect(report.gradientRatio).toBeGreaterThan(1.01)
      expect(report.diagnostics.passes.includes('pixel_shuffle')).toBe(tier === 'quality')
    }
    await page.evaluate(() => {
      const gpu = document.querySelector('.camera-canvas-gpu')!
      Object.defineProperty(window, '__s2OldCanvas', { configurable: true, value: gpu })
    })
    await selectTier(page, '关')
    await expect(overlay.locator('.camera-canvas-gpu')).toHaveCount(0)
    expect(await page.evaluate(async () => {
      const old = (window as unknown as { __s2OldCanvas: { readUpscalePixels(): Promise<unknown> } }).__s2OldCanvas
      try { await old.readUpscalePixels(); return false } catch { return true }
    })).toBe(true)
    await selectTier(page, '省电')
    await expect(overlay).toHaveAttribute('data-upscale-mode', 'webgpu')
    const beforeResize = await overlay.locator('.camera-canvas-gpu').evaluate((canvas: HTMLCanvasElement) => canvas.width)
    const grip = await overlay.locator('.camera-resize').boundingBox()
    if (!grip) throw new Error('摄像头缩放控件不可用')
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await page.mouse.down()
    await page.mouse.move(grip.x + 75, grip.y + 45, { steps: 6 })
    await page.mouse.up()
    await expect.poll(() => overlay.locator('.camera-canvas-gpu').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(beforeResize + 50)
    await testInfo.attach('GPU读回指标', { path: path.join(evidence, 'metrics.json'), contentType: 'application/json' })
    expect(await page.locator('video.media-element').count()).toBe(2)
  })
})
