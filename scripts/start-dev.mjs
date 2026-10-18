/** Vite watch builds served only through Electron's privileged app scheme. */
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { buildElectron } from './build-electron.mjs'
import { launchElectron } from './start-electron.mjs'

await buildElectron()
const root = new URL('../', import.meta.url)
const watcher = await build({ configFile: fileURLToPath(new URL('vite.config.ts', root)), build: { watch: {} } })
let electron
let closing = false
const stop = async () => {
  if (closing) return
  closing = true
  electron?.kill()
  await watcher.close()
}
watcher.on('event', (event) => {
  if (event.code === 'ERROR') console.error('前端构建失败, 等待下一次修改')
  if (event.code === 'END' && !electron && !closing) {
    electron = launchElectron({ STREAM_SYNC_DEV: '1' })
    electron.once('exit', (code) => { process.exitCode = code ?? 1; void stop() })
    electron.once('error', () => { process.exitCode = 1; void stop() })
  }
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })
