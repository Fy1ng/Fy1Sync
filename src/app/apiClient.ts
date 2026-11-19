/** Typed renderer seam for the allow-listed Electron preload API. */

import type { DesktopMethods, StreamSyncerBridge, WindowState } from '../../electron/contracts'
import type { ResolveFailure, ResolvedStream } from '../../server/platforms/types'
import type { SourceRole } from '../core/types'
import type { BufferState } from '../../electron/bufferManager'
import type { LoginPlatform } from '../../electron/login'
import type { DecoderMode } from '../../electron/decoderPreferences'
import type { DouyuAccountsSnapshot, DouyuTaskPolicy, DouyuTasksSnapshot } from '../../server/douyu/types'
import type { DomesticRouting } from '../../server/networkPolicy'
import type { MediaNetworkOptions } from '../../server/mediaNetworkOptions'
import type { FeatureMethod, FeatureMethods, FeatureEvent } from '../../electron/featureContracts'
import type { EmbeddedLoginState, EmbeddedLoginViewport } from '../../electron/embeddedLoginContracts'
import { DOUYIN_LOGIN_CHANGED_EVENT } from '../core/douyinMessage'
import { errorDetails } from '../core/errorDetails'
import type { BrowserImportMethods } from '../../electron/browserImportContracts'

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; detail?: unknown }

export interface HealthInfo {
  ok: boolean
  version: string
  proxyEnabled: boolean
  danmakuRooms: number
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
    if (!bridge) throw new Error('请在 Fy1Sync 桌面应用中打开')
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
        message: '无法连接 Fy1Sync，请重新启动应用',
        detail: errorDetails(error),
      }
    }
  }

  health(): Promise<ApiResult<HealthInfo>> {
    return this.request('health', undefined)
  }

  getDecoderPreferences() { return this.request('getDecoderPreferences', undefined) }
  getDouyinSendState(refresh = false) { return this.request('getDouyinSendState', refresh ? { refresh: true } : undefined) }
  sendDouyinMessage(input: DesktopMethods['sendDouyinMessage']['args']) { return this.request('sendDouyinMessage', input) }
  feature<K extends FeatureMethod>(method: K, args: FeatureMethods[K]['args']) { return this.request(method, args) }
  subscribeFeatures(listener: (event: FeatureEvent) => void): () => void {
    try { return this.bridge().subscribeFeatures?.(listener) ?? (() => {}) } catch { return () => {} }
  }
  getToolsStatus() { return this.request('getToolsStatus', undefined) }
  getAcquisitionDiagnostics() { return this.request('getAcquisitionDiagnostics', undefined) }
  updateYtdlp() { return this.request('updateYtdlp', undefined) }
  restoreYtdlp(target: 'previous' | 'bundled') { return this.request('restoreYtdlp', { target }) }
  setDecoderPreferences(mode: DecoderMode) { return this.request('setDecoderPreferences', { mode }) }

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
  reconnectDanmaku(room: string) { return this.request('reconnectDanmaku', { room }) }
  async login(platform: LoginPlatform) {
    const result = await this.request('login', { platform })
    if (platform === 'douyin' && typeof window !== 'undefined') window.dispatchEvent(new Event(DOUYIN_LOGIN_CHANGED_EVENT))
    return result
  }
  loginStatus() { return this.request('loginStatus', undefined) }
  listBrowserImportProfiles() { return this.request('listBrowserImportProfiles', undefined) }
  previewBrowserLogins(input: BrowserImportMethods['previewBrowserLogins']['args']) { return this.request('previewBrowserLogins', input) }
  async importBrowserLogins(input: BrowserImportMethods['importBrowserLogins']['args']) {
    const result = await this.request('importBrowserLogins', input)
    if (typeof window !== 'undefined' && result.ok && result.value.outcomes.some(outcome => outcome.platform === 'douyin' && outcome.imported)) {
      window.dispatchEvent(new Event(DOUYIN_LOGIN_CHANGED_EVENT))
    }
    return result
  }
  cancelBrowserImport(id: string) { return this.request('cancelBrowserImport', { id }) }
  async logout(platform: LoginPlatform) {
    const result = await this.request('logout', { platform })
    if (platform === 'douyin' && typeof window !== 'undefined') window.dispatchEvent(new Event(DOUYIN_LOGIN_CHANGED_EVENT))
    return result
  }
  getEmbeddedLogin() { return this.request('getEmbeddedLogin', undefined) }
  setEmbeddedLoginViewport(viewport: EmbeddedLoginViewport) { return this.request('setEmbeddedLoginViewport', viewport) }
  cancelEmbeddedLogin(id: string) { return this.request('cancelEmbeddedLogin', { id }) }
  retryEmbeddedLogin(id: string) { return this.request('retryEmbeddedLogin', { id }) }
  backEmbeddedLogin(id: string) { return this.request('backEmbeddedLogin', { id }) }
  subscribeEmbeddedLogin(listener: (state: EmbeddedLoginState | null) => void): () => void {
    try { return this.bridge().subscribeEmbeddedLogin?.(listener) ?? (() => {}) } catch { return () => {} }
  }
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
  subscribeDouyuAccounts(listener: (state: DouyuAccountsSnapshot) => void): () => void {
    try { return this.bridge().subscribeDouyuAccounts?.(listener) ?? (() => {}) } catch { return () => {} }
  }
  getNetworkPreferences() { return this.request('getNetworkPreferences', undefined) }
  setNetworkPreferences(domesticRouting: DomesticRouting, media?: MediaNetworkOptions) {
    return this.request('setNetworkPreferences', { domesticRouting, ...(media ? { media } : {}) })
  }
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

export const apiClient = new ApiClient()
