/**
 * Typed client for this app's own server API.
 *
 * Every call answers with a discriminated result rather than throwing, because each of
 * these endpoints has a failure the UI must *show* — an unreachable server, a rejected
 * admin token, a platform that refused to resolve. A thrown error would collapse all of
 * those into one catch block that can only say "something went wrong".
 *
 * `/api/resolve` is the one worth noting: a platform that cannot be resolved answers
 * `200` with `ok: false` and a hint, so a network error and "this room is offline" stay
 * distinguishable. See docs/platform-notes.md.
 */

import type { ResolveFailure, ResolvedStream } from '../../server/platforms/types'
import type { ProfileIssue, RecognitionProfile } from '../core/profileSchema'

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; detail?: unknown }

export interface HealthInfo {
  ok: boolean
  version: string
  proxyEnabled: boolean
  danmakuRooms: number
}

export interface PresetSummary {
  id: string
  name: string
  updatedAt: number
  etag: string
  templateChars: number
}

export interface PresetRecord {
  profile: RecognitionProfile
  etag: string
}

export interface SavedPreset {
  id: string
  etag: string
  updatedAt: number
}

/** Errors the server sends as `{ error: { code, message } }`. */
interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; issues?: unknown; currentEtag?: unknown }
}

const NETWORK_FAILURE = 'network-error'

async function request<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetchImpl(path, {
      // Same-origin only: the server rejects cross-site writes, and there is no reason
      // for this client to ever talk to another origin.
      credentials: 'same-origin',
      ...init,
    })
  } catch (error) {
    return {
      ok: false,
      code: NETWORK_FAILURE,
      message: `无法连接本地服务：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const text = await response.text()
  let payload: unknown = undefined
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      // A non-JSON body from our own API means the request was answered by something
      // else (a dev-server fallback, a proxy). Say so rather than blaming the parse.
      return {
        ok: false,
        code: 'bad-response',
        message: `服务返回了非 JSON 响应（HTTP ${response.status}）`,
      }
    }
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ErrorEnvelope
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'http-error'
    const message =
      typeof envelope.error?.message === 'string'
        ? envelope.error.message
        : `请求失败（HTTP ${response.status}）`
    return { ok: false, code, message, detail: envelope.error }
  }

  return { ok: true, value: (payload ?? {}) as T }
}

function jsonInit(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: ApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
  }

  health(): Promise<ApiResult<HealthInfo>> {
    return request<HealthInfo>('/api/health', {}, this.fetchImpl)
  }

  /** Verify an admin token server-side. The editor refuses to render before this passes. */
  verifyAdmin(token: string): Promise<ApiResult<{ ok: true }>> {
    return request<{ ok: true }>(
      '/api/admin/verify',
      jsonInit('POST', { token }),
      this.fetchImpl,
    )
  }

  /**
   * Resolve a channel/room/URL into something playable.
   *
   * The nested `ok` is the platform's answer, not the transport's: a resolved stream and
   * a structured refusal both arrive as HTTP 200.
   */
  async resolve(
    input: string,
    platform?: string,
  ): Promise<ApiResult<{ ok: true; stream: ResolvedStream } | { ok: false; failure: ResolveFailure }>> {
    return request('/api/resolve', jsonInit('POST', { input, platform }), this.fetchImpl)
  }

  listPresets(): Promise<ApiResult<{ presets: PresetSummary[] }>> {
    return request<{ presets: PresetSummary[] }>('/api/presets', {}, this.fetchImpl)
  }

  getPreset(id: string): Promise<ApiResult<PresetRecord>> {
    return request<PresetRecord>(`/api/presets/${encodeId(id)}`, {}, this.fetchImpl)
  }

  /**
   * Write a preset. `etag` becomes an `If-Match`, so a stale editor gets a `409`
   * instead of silently overwriting another session's work.
   */
  savePreset(
    id: string,
    profile: RecognitionProfile,
    token: string,
    etag?: string,
  ): Promise<ApiResult<SavedPreset>> {
    const headers: Record<string, string> = { 'x-admin-token': token }
    if (etag) headers['if-match'] = `"${etag}"`
    return request<SavedPreset>(
      `/api/presets/${encodeId(id)}`,
      jsonInit('PUT', profile, headers),
      this.fetchImpl,
    )
  }

  deletePreset(id: string, token: string): Promise<ApiResult<{ ok: true }>> {
    return request<{ ok: true }>(
      `/api/presets/${encodeId(id)}`,
      { method: 'DELETE', headers: { 'x-admin-token': token } },
      this.fetchImpl,
    )
  }
}

/** Preset ids contain a slash (`cs2/iem`), which is path structure, not data to escape. */
function encodeId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

/** Validation issues ride along on a 422; pull them out without trusting the shape. */
export function issuesFrom(detail: unknown): ProfileIssue[] {
  const issues = (detail as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues)) return []
  return issues.filter((issue): issue is ProfileIssue => {
    const candidate = issue as ProfileIssue | undefined
    return typeof candidate?.path === 'string' && typeof candidate?.message === 'string'
  })
}

export const apiClient = new ApiClient()
