import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = new URL('../', import.meta.url)
export async function buildElectron(write = true) {
  const obsolete = fileURLToPath(new URL('dist/server', root))
  if (dirname(obsolete) !== resolve(fileURLToPath(root), 'dist')) throw new Error('Invalid obsolete artifact path')
  if (write) await rm(obsolete, { recursive: true, force: true })
  const result = await build({
    configFile: false, root: fileURLToPath(root),
    ssr: { noExternal: ['parse5', 'entities'] },
    build: {
      ssr: true, outDir: 'dist/electron', emptyOutDir: true, minify: false, sourcemap: true,
      target: 'node24', write,
      rollupOptions: {
        input: { main: fileURLToPath(new URL('electron/main.ts', root)), preload: fileURLToPath(new URL('electron/preload.ts', root)) },
        external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  })
  if (write) {
    await mkdir(new URL('dist', root), { recursive: true })
    const { name, version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    await writeFile(new URL('dist/package.json', root), JSON.stringify({ name, version, main: 'electron/main.cjs' }, null, 2) + '\n')
  }
  return result
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildElectron()
