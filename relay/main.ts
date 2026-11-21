import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { resolve } from 'node:path'
import { version } from '../package.json'
import { ScheduleRelay } from './service'

const port = Number(process.env.RELAY_PORT ?? '5081')
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid RELAY_PORT')
// Upstream IPv4 handshakes from the relay VPS took 205 to 246 ms, close to Node's
// 250 ms default. Allow time for retransmits before falling back to IPv6, which
// has no default route on the VPS.
setDefaultAutoSelectFamilyAttemptTimeout(5_000)
const relay = new ScheduleRelay({ dataDir: resolve(process.env.RELAY_DATA_DIR ?? './data'), version,
  offline: process.env.RELAY_OFFLINE !== undefined })
const stop = () => {
  void relay.dispose().then(() => {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }).catch(() => { process.exitCode = 1 })
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
async function start(): Promise<void> {
  try { await relay.start(process.env.RELAY_HOST ?? '127.0.0.1', port) }
  catch {
    await relay.dispose()
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    process.exitCode = 1
  }
}
void start()
