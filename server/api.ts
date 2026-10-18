/**
 * The API surface, defined once and mounted by both the Vite dev middleware and the
 * production server. Anything that behaves differently between dev and prod is a bug
 * waiting for release day, so there is exactly one router.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { ServerConfig } from './config'
import { DanmakuRelay, attachSseSubscriber } from './danmaku/relay'
import {
  clientIsLoopback,
  isSameOriginRequest,
  matchRoute,
  readJsonBody,
  requestUrl,
  sendError,
  sendJson,
  type RequestContext,
  type Route,
} from './http'
import { handleProxyRequest, PROXY_PATH } from './mediaProxy'
import { parseDouyuRoom, resolveStream, type PlatformKind } from './platforms'
import { PresetStore } from './presetStore'
import { safeFetch } from './safeFetch'

export type ApiDeps = {
  config: ServerConfig
  relay?: DanmakuRelay
  presets?: PresetStore
  fetchImpl?: typeof fetch
}

export type Api = {
  /** Returns true when the request was handled. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  dispose: () => void
}

export function createApi(deps: ApiDeps): Api {
  const config = deps.config
  const relay = deps.relay ?? new DanmakuRelay()
  const presets = deps.presets ?? new PresetStore(config.dataDir)
  const routes = buildRoutes(config, relay, presets, deps.fetchImpl)

  return {
    async handle(req, res) {
      const url = requestUrl(req)
      if (!url.pathname.startsWith('/api/')) return false

      const method = req.method ?? 'GET'
      const match = matchRoute(routes, method, url.pathname)
      if (!match) {
        sendError(res, 404, 'not-found', `未知接口 ${method} ${url.pathname}`)
        return true
      }

      // A loopback-bound service is still reachable from any page in the user's browser.
      if (method !== 'GET' && method !== 'HEAD' && !isSameOriginRequest(req)) {
        sendError(res, 403, 'cross-origin', '拒绝跨站请求')
        return true
      }
      if (config.loopbackOnly && !clientIsLoopback(req)) {
        sendError(res, 403, 'not-loopback', '该服务仅接受本机访问')
        return true
      }

      const ctx: RequestContext = { req, res, url, method, params: match.params }
      try {
        await match.route.handler(ctx)
      } catch (error) {
        if (!res.headersSent) {
          sendError(
            res,
            500,
            'internal-error',
            `服务端错误：${error instanceof Error ? error.message : String(error)}`,
          )
        } else {
          res.destroy()
        }
      }
      return true
    },
    dispose() {
      relay.closeAll()
    },
  }
}

function buildRoutes(
  config: ServerConfig,
  relay: DanmakuRelay,
  presets: PresetStore,
  fetchImpl?: typeof fetch,
): Route[] {
  const resolverDeps = createResolverDeps(config, fetchImpl)

  return [
    {
      method: 'GET',
      pattern: '/api/health',
      handler: ({ res }) => {
        sendJson(res, 200, {
          ok: true,
          version: '0.1.0',
          proxyEnabled: config.proxy.enabled,
          danmakuRooms: relay.roomCount,
        })
      },
    },

    // Admin gate: the editor asks before rendering, so the token is never checked
    // client-side only. It is compared in constant time to avoid a timing oracle.
    {
      method: 'POST',
      pattern: '/api/admin/verify',
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        if (!body.ok) {
          sendError(res, 400, body.code, body.message)
          return
        }
        const token = (body.value as { token?: unknown } | undefined)?.token
        const ok = typeof token === 'string' && constantTimeEqual(token, config.adminToken)
        // A wrong token gets a 403 with no hint about length or content.
        if (!ok) {
          sendError(res, 403, 'bad-token', '管理令牌不正确')
          return
        }
        sendJson(res, 200, { ok: true })
      },
    },

    {
      method: 'POST',
      pattern: '/api/resolve',
      handler: async ({ req, res }) => {
        const body = await readJsonBody(req)
        if (!body.ok) {
          sendError(res, 400, body.code, body.message)
          return
        }
        const payload = (body.value ?? {}) as { input?: unknown; platform?: unknown }
        if (typeof payload.input !== 'string' || payload.input.trim().length === 0) {
          sendError(res, 400, 'missing-input', '缺少要解析的地址或频道名')
          return
        }
        const explicit = isPlatformKind(payload.platform) ? payload.platform : undefined
        const result = await resolveStream(payload.input, resolverDeps, explicit)
        if (!result.ok) {
          // 200 with a structured failure: the UI shows the hint, this is not an HTTP error.
          sendJson(res, 200, { ok: false, failure: result.failure })
          return
        }
        sendJson(res, 200, { ok: true, stream: result.stream })
      },
    },

    {
      method: 'GET',
      pattern: PROXY_PATH,
      handler: ({ req, res, url }) =>
        handleProxyRequest(req, res, url, {
          config: config.proxy,
          fetchImpl,
        }),
    },

    {
      method: 'GET',
      pattern: '/api/danmaku/douyu/:room',
      handler: ({ req, res, params }) => {
        const room = parseDouyuRoom(params.room ?? '')
        if (!room) {
          sendError(res, 400, 'bad-room', '房间号必须是数字')
          return
        }
        attachSseSubscriber(relay, room, req, res)
      },
    },

    { method: 'GET', pattern: '/api/presets', handler: async ({ res }) => {
      const records = await presets.list()
      sendJson(res, 200, {
        presets: records.map((record) => ({
          id: record.id,
          name: record.profile.name,
          updatedAt: record.updatedAt,
          etag: record.etag,
          templateChars: Object.keys(record.profile.templates).length,
        })),
      })
    } },

    {
      method: 'GET',
      pattern: '/api/presets/*',
      handler: async ({ res, params }) => {
        const record = await presets.get(params.rest ?? '')
        if (!record) {
          sendError(res, 404, 'not-found', '预设不存在')
          return
        }
        sendJson(
          res,
          200,
          { profile: record.profile, etag: record.etag },
          { etag: `"${record.etag}"` },
        )
      },
    },

    {
      method: 'PUT',
      pattern: '/api/presets/*',
      handler: async (ctx) => {
        if (!requireAdmin(ctx, config)) return
        const body = await readJsonBody(ctx.req)
        if (!body.ok) {
          sendError(ctx.res, body.code === 'too-large' ? 413 : 400, body.code, body.message)
          return
        }
        const ifMatch = ctx.req.headers['if-match']
        const outcome = await presets.save(
          ctx.params.rest ?? '',
          body.value,
          typeof ifMatch === 'string' ? ifMatch.replace(/"/g, '') : undefined,
        )
        if (!outcome.ok) {
          switch (outcome.code) {
            case 'invalid':
              sendError(ctx.res, 422, 'invalid-profile', '配置校验未通过', {
                issues: outcome.issues,
              })
              return
            case 'too-large':
              sendError(ctx.res, 413, 'too-large', outcome.message)
              return
            case 'conflict':
              sendError(ctx.res, 409, 'conflict', '预设已被其他会话修改', {
                currentEtag: outcome.currentEtag,
              })
              return
            default:
              sendError(ctx.res, 500, 'io-error', outcome.message)
              return
          }
        }
        sendJson(
          ctx.res,
          outcome.created ? 201 : 200,
          { id: outcome.record.id, etag: outcome.record.etag, updatedAt: outcome.record.updatedAt },
          { etag: `"${outcome.record.etag}"` },
        )
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/presets/*',
      handler: async (ctx) => {
        if (!requireAdmin(ctx, config)) return
        const removed = await presets.remove(ctx.params.rest ?? '')
        if (!removed) {
          sendError(ctx.res, 404, 'not-found', '预设不存在')
          return
        }
        sendJson(ctx.res, 200, { ok: true })
      },
    },
  ]
}

/** Preset writes are admin-only; the token travels in a header, never in a URL. */
function requireAdmin(ctx: RequestContext, config: ServerConfig): boolean {
  const header = ctx.req.headers['x-admin-token']
  const token = typeof header === 'string' ? header : ''
  if (!constantTimeEqual(token, config.adminToken)) {
    sendError(ctx.res, 403, 'bad-token', '需要管理令牌')
    return false
  }
  return true
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

function isPlatformKind(value: unknown): value is PlatformKind {
  return value === 'twitch' || value === 'douyu' || value === 'bilibili' || value === 'direct'
}

/**
 * Resolver I/O goes through the same SSRF guard as the media proxy, with the platform
 * API hosts allowed explicitly. A resolver is just another place where a URL derived
 * from user input reaches `fetch`.
 */
function createResolverDeps(config: ServerConfig, fetchImpl?: typeof fetch) {
  const proxyConfig = { ...config.proxy, enabled: true }
  const request = async (url: string, init?: RequestInit): Promise<Response> => {
    const { response } = await safeFetch(url, proxyConfig, {
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        ...(init?.headers as Record<string, string> | undefined),
      },
      body: typeof init?.body === 'string' ? init.body : undefined,
      fetchImpl,
    })
    return response
  }

  return {
    fetchJson: async (url: string, init?: RequestInit): Promise<unknown> => {
      const response = await request(url, init)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response.json()
    },
    fetchText: async (url: string, init?: RequestInit): Promise<string> => {
      const response = await request(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    },
    proxify: (url: string): string => `${PROXY_PATH}?url=${encodeURIComponent(url)}`,
  }
}
