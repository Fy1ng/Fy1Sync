import react from '@vitejs/plugin-react'
import { buildWasm } from './scripts/build-wasm.mjs'
import { defineConfig } from 'vitest/config'

const sharedExclude = [
  '**/node_modules/**',
  '**/dist/**',
  'Stream Sync Player/**',
  'Stream Sync Player_Gemini/**',
]

export default defineConfig(async () => {
  await buildWasm()
  return {
    test: {
      projects: [
        {
          plugins: [react()],
          test: {
            name: 'web',
            environment: 'jsdom',
            globals: false,
            setupFiles: ['./src/test/setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'],
            exclude: [...sharedExclude, 'src/wasm/auto.test.ts'],
          },
        },
        {
          test: {
            name: 'server',
            environment: 'node',
            globals: false,
            include: ['server/**/*.test.ts', 'electron/**/*.test.ts', 'src/wasm/auto.test.ts'],
            exclude: sharedExclude,
          },
        },
      ],
    },
  }
})
