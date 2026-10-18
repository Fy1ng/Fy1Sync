import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.STREAM_SYNC_E2E_PORT ?? 4181)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'off',
    // Autoplay of muted/unmuted media without a user gesture, so player tests are deterministic.
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Runs before the webServer boots; see the file for why an empty store matters.
  globalSetup: './e2e/globalSetup.ts',
  webServer: {
    command: 'node scripts/start-dev.mjs',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      STREAM_SYNC_PORT: String(port),
      STREAM_SYNC_STRICT_PORT: '1',
      STREAM_SYNC_ADMIN_TOKEN: 'e2e-admin-token',
      // A dedicated store, so preset writes are exercised for real without touching the
      // developer's own `data/` directory.
      STREAM_SYNC_DATA_DIR: fileURLToPath(new URL('./e2e/.data', import.meta.url)),
    },
  },
})
