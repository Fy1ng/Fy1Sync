import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { apiDevPlugin } from './server/viteApiPlugin'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Reference-only sibling directories. They are not part of this implementation and
 * must never be crawled by the dev server, the watcher or the production build.
 */
const referenceDirs = ['**/Stream Sync Player/**', '**/Stream Sync Player_Gemini/**']

export default defineConfig(({ command }) => ({
  root: rootDir,
  appType: 'spa',
  plugins: [react(), apiDevPlugin()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.STREAM_SYNC_PORT ?? 5173),
    strictPort: false,
    watch: { ignored: referenceDirs },
    fs: { deny: referenceDirs },
  },
  preview: {
    host: '127.0.0.1',
    port: Number(process.env.STREAM_SYNC_PORT ?? 4173),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: command === 'build' ? 'hidden' : false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/hls.js')) return 'hls'
          if (id.includes('node_modules/react')) return 'react'
          return undefined
        },
      },
    },
  },
  optimizeDeps: {
    // hls.js is imported lazily; keep it out of the eager prebundle graph.
    exclude: ['hls.js'],
  },
  worker: { format: 'es' },
}))
