/** Typed renderer seam for the allow-listed Electron preload API. */

import type { DesktopMethods, StreamSyncerBridge, WindowState } from '../../electron/contracts'
import type { ResolveFailure, ResolvedStream } from '../../server/platforms/types'
import type { ProfileIssue, RecognitionProfile } from '../core/profileSchema'
import type { SourceRole } from '../core/types'
import type { BufferState } from '../../electron/bufferManager'
import type { LoginPlatform } from '../../electron/login'
import type { DecoderMode } from '../../electron/decoderPreferences'
import type { DouyuTaskPolicy, DouyuTasksSnapshot } from '../../server/douyu/types'
import type { FeatureMethod, FeatureMethods, FeatureEvent } from '../../electron/featureContracts'

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
  feature<K extends FeatureMethod>(method: K, args: FeatureMethods[K]['args']) { return this.request(method, args) }
  subscribeFeatures(listener: (event: FeatureEvent) => void): () => void {
    try { return this.bridge().subscribeFeatures?.(listener) ?? (() => {}) } catch { return () => {} }
  }
  getToolsStatus() { return this.request('getToolsStatus', undefined) }
  updateYtdlp() { return this.request('updateYtdlp', undefined) }
  restoreYtdlp(target: 'previous' | 'bundled') { return this.request('restoreYtdlp', { target }) }
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

  resolveDouyuRoom(input: string) { return this.request('resolveDouyuRoom', { input }) }
  switchQuality(role: SourceRole, quality: string) { return this.request('switchQuality', { role, quality }) }
  stopBuffer(role: SourceRole) { return this.request('stopBuffer', { role }) }
  login(platform: LoginPlatform) { return this.request('login', { platform }) }
  loginStatus() { return this.request('loginStatus', undefined) }
  logout(platform: LoginPlatform) { return this.request('logout', { platform }) }
  listDouyuAccounts() { return this.request('listDouyuAccounts', undefined) }
  addDouyuAccount(label: string) { return this.request('addDouyuAccount', { label }) }
  renameDouyuAccount(id: string, label: string) { return this.request('renameDouyuAccount', { id, label }) }
  loginDouyuAccount(id: string) { return this.request('loginDouyuAccount', { id }) }
  loginDouyuYubaAccount(id: string) { return this.request('loginDouyuYubaAccount', { id }) }
  openDouyuTaskRoom(id: string) { return this.request('openDouyuTaskRoom', { id }) }
  sendDouyuMessage(input: DesktopMethods['sendDouyuMessage']['args']) { return this.request('sendDouyuMessage', input) }
  getDouyuRenewalTargets(accountId: string) { return this.request('getDouyuRenewalTargets', { accountId }) }
  previewDouyuRenewal(input: DesktopMethods['previewDouyuRenewal']['args']) { return this.request('previewDouyuRenewal', input) }
  executeDouyuRenewal(planId: string) { return this.request('executeDouyuRenewal', { planId }) }
  cancelDouyuRenewal(planId: string) { return this.request('cancelDouyuRenewal', { planId }) }
  activateDouyuAccount(id: string) { return this.request('activateDouyuAccount', { id }) }
  logoutDouyuAccount(id: string) { return this.request('logoutDouyuAccount', { id }) }
  removeDouyuAccount(id: string) { return this.request('removeDouyuAccount', { id }) }
  getDouyuTasks() { return this.request('getDouyuTasks', undefined) }
  createDouyuTask(input: DesktopMethods['createDouyuTask']['args']) { return this.request('createDouyuTask', input) }
  setDouyuTaskPolicy(id: string, policy: DouyuTaskPolicy) { return this.request('setDouyuTaskPolicy', { id, policy }) }
  startDouyuTask(id: string) { return this.request('startDouyuTask', { id }) }
  pauseDouyuTask(id: string) { return this.request('pauseDouyuTask', { id }) }
  removeDouyuTask(id: string) { return this.request('removeDouyuTask', { id }) }
  retainDouyuTaskRoom(room: string, retain: boolean) { return this.request('retainDouyuTaskRoom', { room, retain }) }
  closeDouyuTaskRoom(room: string) { return this.request('closeDouyuTaskRoom', { room }) }
  subscribeDouyuTasks(listener: (state: DouyuTasksSnapshot) => void): () => void {
    try { return this.bridge().subscribeDouyuTasks?.(listener) ?? (() => {}) } catch { return () => {} }
  }
  subscribeBuffer(listener: (state: BufferState) => void): () => void {
    try { return this.bridge().subscribeBuffer?.(listener) ?? (() => {}) } catch { return () => {} }
  }

  // The page-drawn title bar's window controls; each acts on the window that asks.
  getWindowState() { return this.request('getWindowState', undefined) }
  windowControl(action: DesktopMethods['windowControl']['args']['action']) { return this.request('windowControl', { action }) }
  subscribeWindowState(listener: (state: WindowState) => void): () => void {
    try { return this.bridge().subscribeWindowState?.(listener) ?? (() => {}) } catch { return () => {} }
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
