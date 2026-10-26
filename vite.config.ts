import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command }) => ({
  root: rootDir,
  appType: 'spa',
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: command === 'build' ? 'hidden' : false,
    chunkSizeWarningLimit: 700,
    // The CSP allows fonts from the app only, not data: URLs, so no font may be inlined.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
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
