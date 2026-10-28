import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.STREAM_SYNC_E2E_OUTPUT_DIR || 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  projects: [{ name: 'electron' }],
  // e2e/electron.ts starts a built app per scenario; no HTTP server or browser is started.
})
