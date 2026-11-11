/** Build and launch an isolated, author-only configuration utility. Nothing is copied into dist. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const sourceRoot = join(projectRoot, 'scripts', 'clock-search-authoring')
const outputRoot = join(projectRoot, '.runtime-cache', 'clock-search-authoring')
const options = new Set(process.argv.slice(2))
for (const option of options) if (!['--reset', '--build-only'].includes(option)) throw new Error('未知制作参数: ' + option)
await mkdir(outputRoot, { recursive: true })
await build({ configFile: false, root: sourceRoot, base: './', plugins: [react()],
  build: { outDir: join(outputRoot, 'client'), emptyOutDir: false, assetsInlineLimit: 0, sourcemap: 'hidden' } })
for (const [entry, name] of [['main.ts', 'main.cjs'], ['preload.ts', 'preload.cjs']]) {
  await build({ configFile: false, root: projectRoot,
    build: { ssr: join(sourceRoot, entry), outDir: outputRoot, emptyOutDir: false, target: 'node24',
      minify: false, sourcemap: true, rollupOptions: { external: ['electron', /^node:/],
        output: { format: 'cjs', entryFileNames: name, codeSplitting: false } } } })
}
const main = join(outputRoot, 'main.cjs')
if (options.has('--build-only')) {
  console.log('制作工具构建完成: ' + main)
} else {
  const temporaryParent = resolve(tmpdir())
  const profileRoot = await mkdtemp(join(temporaryParent, 'fy1sync-clock-author-'))
  const profile = join(profileRoot, 'userData')
  await mkdir(profile)
  const require = createRequire(import.meta.url)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Test-only overrides are never inherited by the normal authoring command.
  delete env.STREAM_SYNC_AUTHOR_CONFIG_PATH
  delete env.STREAM_SYNC_E2E
  const child = spawn(require('electron'), [main, '--project-root=' + projectRoot,
    '--profile-dir=' + profile, ...(options.has('--reset') ? ['--reset'] : [])],
    { cwd: projectRoot, env, stdio: 'inherit', windowsHide: false })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill())
  try {
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code)) })
    process.exitCode = code ?? 1
  } finally {
    if (dirname(resolve(profileRoot)) !== temporaryParent || !basename(profileRoot).startsWith('fy1sync-clock-author-')) {
      throw new Error('制作工具临时目录校验失败')
    }
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
}
