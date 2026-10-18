/**
 * Mounts the production API router into the Vite dev server.
 *
 * The plugin is a thin adapter on purpose: `createApi` owns every route, so `npm run dev`
 * and the built server answer the same requests with the same code. The alternative —
 * dev-only middleware that reimplements the endpoints — is how a project ends up with
 * features that work only under `vite dev`.
 */

import type { Plugin, ViteDevServer } from 'vite'
import { createApi, type Api } from './api'
import { resolveConfig } from './config'

export function apiDevPlugin(): Plugin {
  let api: Api | null = null

  return {
    name: 'stream-sync-api',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      const config = resolveConfig(process.env, process.cwd())
      api = createApi({ config })

      server.middlewares.use((req, res, next) => {
        // Not an /api/ path: hand it back to Vite's own middleware chain.
        void api!.handle(req, res).then(
          (handled) => {
            if (!handled) next()
          },
          (error: unknown) => next(error instanceof Error ? error : new Error(String(error))),
        )
      })

      server.httpServer?.once('listening', () => {
        server.config.logger.info(
          `  [32m➜[0m  API:     /api/health, /api/resolve, /api/proxy, /api/danmaku/douyu/:room, /api/presets`,
        )
        server.config.logger.info(
          `  [32m➜[0m  Admin:   /admin?token=${config.adminToken}`,
        )
      })
    },

    closeBundle() {
      api?.dispose()
      api = null
    },
  }
}

export default apiDevPlugin
