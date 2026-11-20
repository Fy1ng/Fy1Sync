import { build } from 'vite'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)

export async function buildRelay(write = true) {
  return build({
    configFile: false, root: fileURLToPath(root), publicDir: false, ssr: { noExternal: ['parse5', 'entities', 'undici'] },
    build: {
      ssr: fileURLToPath(new URL('relay/main.ts', root)), outDir: 'dist/relay',
      emptyOutDir: true, minify: false, sourcemap: false, target: 'node24', write,
      rollupOptions: {
        external: /^node:/,
        output: { format: 'cjs', entryFileNames: 'relay.cjs', codeSplitting: false },
        plugins: [{ name: 'relay-builtins-only', generateBundle(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue
            const unexpected = [...output.imports, ...output.dynamicImports].filter(id => !id.startsWith('node:'))
            if (unexpected.length) this.error('Relay has unexpected runtime imports: ' + unexpected.join(', '))
          }
        } }],
      },
    },
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildRelay()
