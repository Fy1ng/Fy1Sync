/** Typed renderer seam for the allow-listed Electron preload API. */

import type { DesktopMethods, StreamSyncerBridge } from '../../electron/contracts'
import type { ResolveFailure, ResolvedStream } from '../../server/platforms/types'
import type { ProfileIssue, RecognitionProfile } from '../core/profileSchema'
import type { SourceRole } from '../core/types'
import type { BufferState } from '../../electron/bufferManager'
import type { LoginPlatform } from '../../electron/login'
import type { DecoderMode } from '../../electron/decoderPreferences'

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

export interface ApiClientOptions {
  /** Inject the narrow preload contract without exposing Electron to renderer code. */
  bridge?: StreamSyncerBridge
}

export type DanmakuEvent = { event: string; data: unknown }

export class ApiClient {
  constructor(private readonly options: ApiClientOptions = {}) {}

  private bridge(): StreamSyncerBridge {
    const bridge = this.options.bridge ?? (typeof window !== 'undefined' ? window.streamSyncer : undefined)
    if (!bridge) throw new Error('桌面通信接口不可用, 请从 Electron 应用启动')
    return bridge
  }

  private async request<K extends keyof DesktopMethods>(
    method: K,
    args: DesktopMethods[K]['args'],
  ): Promise<ApiResult<DesktopMethods[K]['result']>> {
    try {
      return await this.bridge().invoke(method, args)
    } catch (error) {
      return {
        ok: false,
        code: 'ipc-error',
        message: `无法连接应用主进程: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  health(): Promise<ApiResult<HealthInfo>> {
    return this.request('health', undefined)
  }

  getDecoderPreferences() { return this.request('getDecoderPreferences', undefined) }
  setDecoderPreferences(mode: DecoderMode) { return this.request('setDecoderPreferences', { mode }) }

  /** Compatibility seam; main authorizes the local app frame rather than a token. */
  verifyAdmin(token = ''): Promise<ApiResult<{ ok: true }>> {
    return this.request('verifyAdmin', { token })
  }

  /** A platform refusal remains distinct from an IPC transport failure. */
  resolve(
    input: string,
    platform?: string,
    role?: SourceRole,
    quality?: string,
    preferAdaptive?: boolean,
  ): Promise<ApiResult<{ ok: true; stream: ResolvedStream } | { ok: false; failure: ResolveFailure }>> {
    return this.request('resolve', {
      input, platform, ...(role ? { role } : {}), ...(quality ? { quality } : {}),
      ...(preferAdaptive !== undefined ? { preferAdaptive } : {}),
    })
  }

  switchQuality(role: SourceRole, quality: string) { return this.request('switchQuality', { role, quality }) }
  stopBuffer(role: SourceRole) { return this.request('stopBuffer', { role }) }
  login(platform: LoginPlatform) { return this.request('login', { platform }) }
  loginStatus() { return this.request('loginStatus', undefined) }
  logout(platform: LoginPlatform) { return this.request('logout', { platform }) }
  subscribeBuffer(listener: (state: BufferState) => void): () => void {
    try { return this.bridge().subscribeBuffer?.(listener) ?? (() => {}) } catch { return () => {} }
  }

  listPresets(): Promise<ApiResult<{ presets: PresetSummary[] }>> {
    return this.request('listPresets', undefined)
  }

  getPreset(id: string): Promise<ApiResult<PresetRecord>> {
    return this.request('getPreset', { id })
  }

  /** Pass the last loaded ETag so stale editors cannot overwrite another edit. */
  savePreset(
    id: string,
    profile: RecognitionProfile,
    token = '',
    etag?: string,
  ): Promise<ApiResult<SavedPreset>> {
    return this.request('savePreset', { id, profile, token, etag })
  }

  deletePreset(id: string, token = ''): Promise<ApiResult<{ ok: true }>> {
    return this.request('deletePreset', { id, token })
  }

  /** Stop delivery before releasing the preload subscription, including queued events. */
  subscribeDanmaku(room: string, listener: (event: DanmakuEvent) => void): () => void {
    let active = true
    const unsubscribe = this.bridge().subscribeDanmaku(room, (event) => {
      if (active) listener(event)
    })
    return () => {
      if (!active) return
      active = false
      unsubscribe()
    }
  }
}

/** Validation issues travel in the failure detail; verify their shape before display. */
export function issuesFrom(detail: unknown): ProfileIssue[] {
  const issues = (detail as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues)) return []
  return issues.filter((issue): issue is ProfileIssue => {
    const candidate = issue as ProfileIssue | undefined
    return typeof candidate?.path === 'string' && typeof candidate?.message === 'string'
  })
}

export const apiClient = new ApiClient()
