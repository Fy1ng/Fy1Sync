import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = new URL('../', import.meta.url)
const noExternal = ['parse5', 'entities', 'undici']

/** A physical, self-contained Node preload, also used inside WebSocket workers. */
export async function buildNetworkRuntime(write = true, outDir = 'dist/electron') {
  return build({
    configFile: false, root: fileURLToPath(root), ssr: { noExternal },
    build: {
      ssr: fileURLToPath(new URL('electron/networkRuntime.ts', root)), outDir,
      emptyOutDir: false, minify: false, sourcemap: true, target: 'node24', write,
      rollupOptions: {
        external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: 'network-runtime.cjs', codeSplitting: false },
      },
    },
  })
}

export async function buildElectron(write = true) {
  const obsolete = fileURLToPath(new URL('dist/server', root))
  if (dirname(obsolete) !== resolve(fileURLToPath(root), 'dist')) throw new Error('Invalid obsolete artifact path')
  if (write) await rm(obsolete, { recursive: true, force: true })
  const result = await build({
    configFile: false, root: fileURLToPath(root),
    ssr: { noExternal },
    build: {
      ssr: true, outDir: 'dist/electron', emptyOutDir: true, minify: false, sourcemap: true,
      target: 'node24', write,
      rollupOptions: {
        input: { main: fileURLToPath(new URL('electron/main.ts', root)) },
        external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  })
  // Sandboxed preload can require Electron, but cannot load a shared relative chunk.
  // A separate single-entry build keeps its whitelist self-contained.
  const preload = await build({
    configFile: false, root: fileURLToPath(root), ssr: { noExternal },
    build: {
      ssr: fileURLToPath(new URL('electron/preload.ts', root)), outDir: 'dist/electron', emptyOutDir: false,
      minify: false, sourcemap: true, target: 'node24', write,
      rollupOptions: { external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: 'preload.cjs', codeSplitting: false } },
    },
  })
  const runtime = await buildNetworkRuntime(write)
  if (write) {
    await mkdir(new URL('dist', root), { recursive: true })
    const { name, version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
    await writeFile(new URL('dist/package.json', root), JSON.stringify({ name, version, main: 'electron/main.cjs' }, null, 2) + '\n')
  }
  return [...(Array.isArray(result) ? result : [result]), ...(Array.isArray(preload) ? preload : [preload]), ...(Array.isArray(runtime) ? runtime : [runtime])]
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildElectron()
