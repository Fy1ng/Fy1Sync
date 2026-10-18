/**
 * Minimal request plumbing shared by the dev-server middleware and the production
 * server, so both run byte-identical handler code. Handlers are plain async functions
 * over `IncomingMessage`/`ServerResponse`; no framework, no dependencies.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type RequestContext = {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  method: string
  params: Record<string, string>
}

export type Handler = (ctx: RequestContext) => Promise<boolean | void> | boolean | void

export type Route = {
  method: string
  /** Path with `:name` segments, or a trailing `*` to match a whole subtree. */
  pattern: string
  handler: Handler
}

/** 1 MiB is well above any preset payload and far below anything worth buffering. */
export const MAX_JSON_BODY_BYTES = 1_048_576

export function requestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? '127.0.0.1'
  return new URL(req.url ?? '/', `http://${host}`)
}

export function matchRoute(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
    const params = matchPattern(route.pattern, pathname)
    if (params) return { route, params }
  }
  return null
}

export function matchPattern(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  const params: Record<string, string> = {}

  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]!
    if (expected === '*') {
      params.rest = pathParts.slice(index).join('/')
      return params
    }
    const actual = pathParts[index]
    if (actual === undefined) return null
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }
    if (expected !== actual) return null
  }

  return patternParts.length === pathParts.length ? params : null
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { error: { code, message, ...extra } })
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; code: 'too-large' | 'invalid-json'; message: string }

/** Read and parse a JSON body, refusing anything over the size limit mid-stream. */
export async function readJsonBody(
  req: IncomingMessage,
  limit = MAX_JSON_BODY_BYTES,
): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, code: 'too-large', message: `请求体超过 ${limit} 字节上限` }
  }

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > limit) {
      req.destroy()
      return { ok: false, code: 'too-large', message: `请求体超过 ${limit} 字节上限` }
    }
    chunks.push(buffer)
  }

  if (total === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch (error) {
    return {
      ok: false,
      code: 'invalid-json',
      message: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Cross-origin guard for a loopback service.
 *
 * A page on any website can send the browser to `http://127.0.0.1:5178/api/...`, so
 * `Origin`/`Sec-Fetch-Site` are checked on state-changing requests: a cross-site
 * request carries an `Origin` that is not ours, and same-origin fetches from our own
 * page always match.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') {
    return site === 'same-origin' || site === 'same-site' || site === 'none'
  }
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === 'null') return true // non-browser client
  try {
    const originHost = new URL(origin).host
    return originHost === req.headers.host
  } catch {
    return false
  }
}

export function clientIsLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}
