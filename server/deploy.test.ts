/** Artifact contract only; actual renderer startup is covered by Electron E2E. */
import { build } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

for (const entry of ['electron/main.ts', 'electron/preload.ts']) {
  describe(entry + ' bundle', () => {
    it('bundles with only Electron and Node builtins external', async () => {
      const result = await build({ configFile: false, logLevel: 'silent', build: { ssr: fileURLToPath(new URL('../' + entry, import.meta.url)), write: false, minify: false, rollupOptions: { external: ['electron', /^node:/], output: { format: 'cjs' } } } })
      const results = Array.isArray(result) ? result : [result]
      for (const output of results) {
        if (!('output' in output)) throw new Error('Expected bundle output')
        for (const chunk of output.output) {
          if (chunk.type !== 'chunk') continue
          expect(chunk.imports.every(name => name === 'electron' || name.startsWith('node:'))).toBe(true)
          expect(chunk.code).not.toMatch(/createServer|server\.listen\(/)
        }
      }
    })
  })
}
it('declares a runnable Electron main instead of a Node HTTP server', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  expect(pkg.main).toBe('dist/electron/main.cjs')
  expect(pkg.scripts.start).toBe('node scripts/start-electron.mjs')
  expect(pkg.devDependencies.electron).toBe('44.9.0')
})
