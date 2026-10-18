import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const sharedExclude = [
  '**/node_modules/**',
  '**/dist/**',
  'Stream Sync Player/**',
  'Stream Sync Player_Gemini/**',
]

export default defineConfig({
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
          exclude: sharedExclude,
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          globals: false,
          include: ['server/**/*.test.ts', 'electron/**/*.test.ts'],
          exclude: sharedExclude,
        },
      },
    ],
  },
})
