/** Explicit opt-in: downloads the official stable executable into a disposable profile. */
import { build } from 'vite'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (!process.argv.includes('--official-download')) throw new Error('Explicit --official-download opt-in is required')
const root = fileURLToPath(new URL('../', import.meta.url)), evidence = path.join(root, '.runtime-cache', 'p7-20261023')
const output = path.join(evidence, 'updater-smoke-module')
await build({ root, configFile: false, build: { ssr: true, target: 'node24', outDir: output, emptyOutDir: true, minify: false,
  rollupOptions: { input: path.join(root, 'electron', 'toolUpdater.ts'), external: [/^node:/], output: { format: 'cjs', entryFileNames: 'updater.cjs' } } } })
const require = createRequire(import.meta.url), { ManagedYtdlp, sha256File } = require(path.join(output, 'updater.cjs'))
const profile = path.join(evidence, `official-update-${randomUUID()}`)
await mkdir(profile)
let result
try {
  const updater = new ManagedYtdlp(profile)
  if (await updater.activePath()) throw new Error('Disposable update profile was not empty')
  const started = Date.now(), state = await updater.update()
  if (state.phase !== 'ready') throw new Error(state.message)
  const active = await updater.activePath()
  const manifest = JSON.parse(await readFile(path.join(profile, 'managed-tools', 'yt-dlp', 'active.json'), 'utf8'))
  const hash = await sha256File(active)
  const restarted = new ManagedYtdlp(profile), restored = await restarted.activePath()
  if (hash !== manifest.active.sha256 || restored !== active || restarted.state().activeVersion !== state.activeVersion) throw new Error('Official downloaded version was not reselected after restart')
  result = { status: 'passed', source: 'official stable yt-dlp/yt-dlp GitHub release through production ManagedYtdlp', version: state.activeVersion, sha256: hash,
    elapsedMs: Date.now() - started, versionProcessVerified: true, hashVerified: true, restartSelectionVerified: true, cookiesUsed: false, profileCleaned: false }
} catch (error) {
  result = { status: 'failed', message: error.message, cookiesUsed: false, profileCleaned: false }
  process.exitCode = 1
} finally {
  if (path.dirname(profile) !== evidence || !/^official-update-[a-f0-9-]{36}$/.test(path.basename(profile))) throw new Error('Invalid smoke profile cleanup')
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  result.profileCleaned = true
  await writeFile(path.join(evidence, 'official-update-smoke.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify(result, null, 2))
