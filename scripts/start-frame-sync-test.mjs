import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchElectron } from './start-electron.mjs'

// This development instance never shares the daily installation's user profile.
const directory = new URL('../.runtime-cache/frame-sync-interactive/', import.meta.url)
for (const name of ['userData', 'data', 'temp']) await mkdir(new URL(`${name}/`, directory), { recursive: true })
const child = launchElectron({
  STREAM_SYNC_DEV: '1', STREAM_SYNC_E2E: '0', STREAM_SYNC_OFFLINE_E2E: '0',
  STREAM_SYNC_USER_DATA_DIR: fileURLToPath(new URL('userData/', directory)),
  STREAM_SYNC_DATA_DIR: fileURLToPath(new URL('data/', directory)),
  TEMP: fileURLToPath(new URL('temp/', directory)), TMP: fileURLToPath(new URL('temp/', directory)),
})
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill())
