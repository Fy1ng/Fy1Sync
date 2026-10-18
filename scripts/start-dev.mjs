/**
 * Dev launcher.
 *
 * Vite serves the client and mounts the same API router the production server uses (see
 * `server/viteApiPlugin.ts`), so there is one process in development and one in production,
 * with the same routes in both. This script exists to pick the port before Vite binds:
 * `strictPort: false` would otherwise silently move the server while Playwright's
 * `webServer.url` still points at the port it was told.
 */

import { createServer } from 'vite'
import { createServer as createProbeServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const HOST = process.env.STREAM_SYNC_HOST?.trim() || '127.0.0.1'
const REQUESTED_PORT = Number(process.env.STREAM_SYNC_PORT ?? 5173)
const STRICT = /^(1|true|yes|on)$/i.test(process.env.STREAM_SYNC_STRICT_PORT ?? '')
const MAX_ATTEMPTS = 12

/** True when nothing else holds the port. A probe is cheaper than a failed Vite boot. */
async function portFree(port) {
  return new Promise((resolve) => {
    const probe = createProbeServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, HOST)
  })
}

async function pickPort() {
  if (STRICT) {
    if (await portFree(REQUESTED_PORT)) return REQUESTED_PORT
    throw new Error(
      `端口 ${REQUESTED_PORT} 已被占用，而 STREAM_SYNC_STRICT_PORT 要求使用该端口。`,
    )
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = REQUESTED_PORT + attempt
    if (await portFree(candidate)) return candidate
  }
  throw new Error(
    `从 ${REQUESTED_PORT} 起的 ${MAX_ATTEMPTS} 个端口都被占用，请设置 STREAM_SYNC_PORT。`,
  )
}

async function main() {
  const port = await pickPort()
  const server = await createServer({
    // `fileURLToPath`, not `.pathname`: on Windows the latter yields `/C:/…` and
    // percent-encodes spaces, so a checkout under "Claude Code Repo" fails to resolve.
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    server: { host: HOST, port, strictPort: true },
  })

  await server.listen()

  const adminToken = process.env.STREAM_SYNC_ADMIN_TOKEN?.trim() || 'stream-sync-admin'
  const url = `http://${HOST}:${port}`
  process.stdout.write(
    [
      '',
      `  Stream Syncer   ${url}`,
      `  Profile Editor  ${url}/admin?token=${adminToken}`,
      '',
      '  开发模式：API 与生产环境共用同一套路由。',
      '',
    ].join('\n'),
  )

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void server.close().then(() => process.exit(0))
    })
  }
}

main().catch((error) => {
  process.stderr.write(`启动失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
