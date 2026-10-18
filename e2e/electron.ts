import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, test as baseTest, type ElectronApplication, type Page } from '@playwright/test'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const testDataRoot = path.join(projectRoot, 'e2e', '.data')

export const APP_ORIGIN = 'app://app'

export interface RunningApplication {
  application: ElectronApplication
  page: Page
  close(): Promise<void>
}

/** Launch the built application with a disposable profile and preset store. */
export async function launchApplication(label: string): Promise<RunningApplication> {
  const dataDir = path.join(testDataRoot, label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) + '-' + randomUUID())
  await mkdir(dataDir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  Object.assign(env, {
    STREAM_SYNC_E2E: '1',
    STREAM_SYNC_USER_DATA_DIR: path.join(dataDir, 'userData'),
    STREAM_SYNC_DATA_DIR: path.join(dataDir, 'data'),
  })

  let application: ElectronApplication | undefined
  try {
    application = await _electron.launch({
      args: [path.join(projectRoot, 'dist', 'electron', 'main.cjs'), '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
      cwd: projectRoot,
      env,
      timeout: 30_000,
    })
    const page = await application.firstWindow({ timeout: 30_000 })
    await page.waitForURL(APP_ORIGIN + '/**', { timeout: 30_000 })
    await page.waitForFunction(() => typeof window.streamSyncer?.invoke === 'function')
    const running = application
    return {
      application: running,
      page,
      async close() {
        try {
          await running.close()
        } finally {
          await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        }
      },
    }
  } catch (error) {
    await application?.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    throw new Error('Electron E2E 启动失败. 请先 npm run build, 并在可启动 Chromium restricted token 的沙箱外终端运行 npx playwright test. ' + String(error))
  }
}

/** Every scenario owns a real app; no browser fixture or renderer bridge mock is used. */
export const test = baseTest.extend<{ electronApp: ElectronApplication }>({
  electronApp: async ({}, use, testInfo) => {
    const running = await launchApplication(testInfo.title)
    try {
      await use(running.application)
    } finally {
      await running.close()
    }
  },
  page: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow())
  },
})

export { expect }
