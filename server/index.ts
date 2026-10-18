/**
 * Production entry point: one `node:http` server that hosts the built client and the API.
 *
 * A single process on loopback is the whole deployment story — `npm run build` then
 * `npm start`. No reverse proxy, no container, no external service. The dev server mounts
 * the same router (see `viteApiPlugin.ts`), so behaviour does not change at release.
 */

import { createServer, type Server } from 'node:http'
import { stat } from 'node:fs/promises'
import { createApi, type Api } from './api'
import { exposureWarnings, resolveConfig, type ServerConfig } from './config'
import { sendMissingClient, serveStatic } from './static'
import { sendError } from './http'

export type StartedServer = {
  server: Server
  config: ServerConfig
  url: string
  close: () => Promise<void>
}

export async function startServer(
  overrides: Partial<ServerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartedServer> {
  const config: ServerConfig = { ...resolveConfig(env, process.cwd()), ...overrides }
  const api: Api = createApi({ config })
  const clientExists = await directoryExists(config.clientDir)

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (await api.handle(req, res)) return
        if (!clientExists) {
          sendMissingClient(res, config.clientDir)
          return
        }
        if (await serveStatic(req, res, { root: config.clientDir })) return
        sendError(res, 404, 'not-found', `未找到 ${req.url ?? '/'}`)
      } catch (error) {
        if (!res.headersSent) {
          sendError(
            res,
            500,
            'internal-error',
            error instanceof Error ? error.message : String(error),
          )
        } else {
          res.destroy()
        }
      }
    })()
  })

  // Long-lived SSE danmaku streams must not be culled by the default 5s keep-alive idle
  // timeout, and a slow upstream segment must not be killed mid-response.
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  server.requestTimeout = 0

  const port = await listen(server, config)
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`

  return {
    server,
    config: { ...config, port },
    url,
    close: async () => {
      api.dispose()
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
        // `close` stops accepting and then waits for every socket to end on its own. A
        // keep-alive browser socket or an open SSE stream would hold it forever, so the
        // sockets are dropped here rather than after the await — otherwise Ctrl+C hangs.
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      })
    },
  }
}

/**
 * Worth trying another port for, rather than giving up on.
 *
 * Exported for tests: provoking a real `EACCES` needs a machine that refuses the port,
 * and whether this one does depends on who is running the suite.
 */
export function isPortUnavailable(error: NodeJS.ErrnoException, port: number): boolean {
  if (error.code === 'EADDRINUSE') return true
  // Windows returns `EACCES` for ports Hyper-V/WSL has reserved, not just for privileged
  // ones. It reserves them in contiguous blocks of a hundred, and 5178 lands inside one on
  // a plain dev box. Below 1024 the same code does mean "not privileged", and no amount of
  // walking fixes that.
  return error.code === 'EACCES' && port >= 1024
}

function bind(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Bind, walking forward from the requested port unless `strictPort` is set. A tool run from
 * a terminal should start rather than abort because something else took 5178.
 *
 * The walk ends at port 0 — let the OS pick — rather than at an error. Ports come in
 * hundred-wide unavailable blocks on Windows, which a short walk cannot clear, and a
 * player that starts somewhere is worth more than one that refuses to start anywhere. Only
 * `strictPort` insists, because that is what the e2e harness needs to know where to look.
 *
 * The returned port comes from the bound socket, not from the request: port 0 means "any
 * free port", and echoing the 0 back would print a URL nobody can open.
 */
async function listen(server: Server, config: ServerConfig): Promise<number> {
  const walk = portsToTry(config)

  for (const [attempt, port] of walk.entries()) {
    try {
      await bind(server, port, config.host)
      const address = server.address()
      return typeof address === 'object' && address !== null ? address.port : port
    } catch (error) {
      const last = attempt === walk.length - 1
      if (last || !isPortUnavailable(error as NodeJS.ErrnoException, port)) throw error
    }
  }
  throw new Error(`无法在 ${config.host} 上绑定端口`)
}

const MAX_PORT = 65_535

/** The requested port, then eleven above it, then 0 for "wherever there is room". */
function portsToTry(config: ServerConfig): number[] {
  if (config.strictPort) return [config.port]
  // 0 already means "anything free", so there is nothing to walk towards from there.
  if (config.port === 0) return [0]
  const walk = Array.from({ length: 12 }, (_unused, index) => config.port + index)
  // Stepping past 65535 raises `ERR_SOCKET_BAD_PORT`, which is neither retryable nor a
  // useful thing to hand the user for the crime of asking for a high port.
  return [...walk.filter((port) => port <= MAX_PORT), 0]
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}


/** Run directly (`node dist/server/index.mjs`), not when imported by a test. */
const isDirectRun =
  process.argv[1] !== undefined &&
  /(?:server[\\/]index|index)\.(?:mjs|js|ts)$/.test(process.argv[1])

if (isDirectRun) {
  startServer()
    .then(({ url, config }) => {
      process.stdout.write(
        [
          '',
          `  Stream Syncer  ${url}`,
          `  Profile Editor ${url}/admin?token=${config.adminToken}`,
          `  媒体代理       ${config.proxy.enabled ? '已启用' : '已关闭'}`,
          `  预设目录       ${config.dataDir}`,
          '',
          ...exposureWarnings(config),
        ].join('\n'),
      )
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `启动失败：${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 1
    })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      process.exitCode = 0
      process.exit()
    })
  }
}
