/** Anonymous production dual-source smoke. No content, IDs, signed URLs or raw errors are printed. */
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const input = process.argv[2] ?? 'kpl'
const seconds = Number(process.argv[3] ?? 180)
const fault = process.argv[4] ?? 'none'
if (!/^[A-Za-z0-9_-]{1,64}$/.test(input) || !Number.isInteger(seconds) || seconds < 1 || seconds > 1800
  || !['none', 'fail-slice', 'fail-cdnws'].includes(fault)) {
  console.error('用法: node scripts/huya-danmaku-smoke.mjs <虎牙房间> <1-1800 秒> [none|fail-slice|fail-cdnws]')
  process.exitCode = 1
} else {
  const startedAt = Date.now()
  let loader, client, sampleTimer, faultTimer, outageTimer
  let activeSocket, sliceAbort
  let connectedAt = 0
  const deliveredIds = new Map()
  const secondsSinceConnect = () => (Date.now() - connectedAt) / 1000
  const inOutage = () => connectedAt > 0 && secondsSinceConnect() >= 15 && secondsSinceConnect() < 30
  const summary = { startedAt: new Date(startedAt).toISOString(), input, requestedSeconds: seconds, elapsedSeconds: 0,
    room: null, status: 'failed', fault, faultWindowSeconds: fault === 'none' ? null : [15, 30],
    states: [], snapshots: [], emitted: { chats: 0, gifts: 0, signals: 0, duplicateIds: 0, idEvictions: 0 }, diagnostics: null, failure: null }
  const snapshot = () => {
    if (summary.snapshots.length < 64) summary.snapshots.push({ elapsedSeconds: Math.round(secondsSinceConnect()),
      state: client.state, emitted: { ...summary.emitted }, diagnostics: client.diagnostics })
  }
  try {
    loader = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, envFile: false,
      logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null } })
    const [{ HuyaRoomClient }, { defaultResolveHuyaDanmakuRoom }, { safeFetchStream }] = await Promise.all([
      loader.ssrLoadModule('/server/danmaku/huyaRoomClient.ts'), loader.ssrLoadModule('/server/danmaku/huyaClient.ts'),
      loader.ssrLoadModule('/server/safeFetchStream.ts'),
    ])
    const metadata = await defaultResolveHuyaDanmakuRoom(input)
    summary.room = metadata.room
    const deps = fault === 'none' ? {} : fault === 'fail-cdnws' ? { createSocket: url => {
      if (inOutage()) throw new Error('Injected receive-only socket outage')
      activeSocket = new WebSocket(url)
      return activeSocket
    } } : { slice: { stream: async (url, policy, options) => {
      if (inOutage()) throw new Error('Injected receive-only HTTP outage')
      sliceAbort = new AbortController()
      return safeFetchStream(url, policy, { ...options, signal: AbortSignal.any([options.signal, sliceAbort.signal]) })
    } } }
    client = new HuyaRoomClient(metadata.room, {
      onMessage(message) {
        summary.emitted[message.system ? 'gifts' : 'chats']++
        if (!/^huya:[^:]+:\d+:[1-9]\d{0,18}$/.test(message.id)) return
        const now = Date.now()
        for (const [id, at] of deliveredIds) { if (now - at < 600_000) break; deliveredIds.delete(id) }
        if (deliveredIds.has(message.id)) summary.emitted.duplicateIds++
        else {
          if (deliveredIds.size >= 8192) { deliveredIds.delete(deliveredIds.keys().next().value); summary.emitted.idEvictions++ }
          deliveredIds.set(message.id, now)
        }
      },
      onSignal() { summary.emitted.signals++ },
      onState(state) { if (summary.states.length < 128) summary.states.push({ state, elapsedSeconds: Math.round(secondsSinceConnect()) }) },
    }, deps)
    connectedAt = Date.now()
    client.connect()
    sampleTimer = setInterval(snapshot, 60_000)
    if (fault !== 'none') faultTimer = setTimeout(() => {
      snapshot()
      if (fault === 'fail-cdnws') activeSocket?.close()
      else sliceAbort?.abort()
    }, 15_000)
    if (fault !== 'none') outageTimer = setTimeout(snapshot, 25_000)
    await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    snapshot()
    summary.diagnostics = client.diagnostics
    summary.status = summary.emitted.chats + summary.emitted.gifts + summary.emitted.signals > 0 ? 'received' : 'no-messages'
    if (summary.diagnostics.sources.cdnws.state !== 'connected' || summary.diagnostics.sources.slice.state !== 'connected') {
      summary.status = 'source-unavailable'
      process.exitCode = 1
    }
  } catch {
    summary.failure = '虎牙双路弹幕冒烟未完成, 元数据或运行环境不可用.'
    process.exitCode = 1
  } finally {
    clearInterval(sampleTimer)
    clearTimeout(faultTimer)
    clearTimeout(outageTimer)
    client?.close()
    await loader?.close()
    summary.elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    console.log(JSON.stringify(summary, null, 2))
  }
}
