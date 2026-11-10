import { contextBridge, ipcRenderer } from 'electron'
import type { StreamSyncerBridge, DesktopMethod, DesktopMethods, DanmakuEvent, WindowState } from './contracts'
import type { ApiResult } from '../src/app/apiClient'
import type { BufferState } from './bufferManager'
import type { DouyuAccountsSnapshot, DouyuTasksSnapshot } from '../server/douyu/types'
import { FEATURE_METHODS, type FeatureEvent } from './featureContracts'
import { YOUTUBE_ADMIN_METHODS, type YtBrowseState, type YtImportJob } from './ytAdminContracts'
import { EDITOR_PROJECT_METHODS } from './editorProjectContracts'
import { EMBEDDED_LOGIN_METHODS, type EmbeddedLoginState } from './embeddedLoginContracts'

const youtubeMethods = new Set<string>(YOUTUBE_ADMIN_METHODS)
const editorMethods = new Set<string>(EDITOR_PROJECT_METHODS)
const embeddedLoginMethods = new Set<string>(EMBEDDED_LOGIN_METHODS)

const methods = new Set<DesktopMethod>([
  ...FEATURE_METHODS,
  ...YOUTUBE_ADMIN_METHODS,
  ...EDITOR_PROJECT_METHODS,
  ...EMBEDDED_LOGIN_METHODS,
  'windowControl', 'getWindowState',
  'listDouyuAccounts', 'addDouyuAccount', 'renameDouyuAccount', 'loginDouyuAccount', 'loginDouyuYubaAccount', 'activateDouyuAccount', 'logoutDouyuAccount', 'removeDouyuAccount',
  'sendDouyuMessage', 'openDouyuTaskRoom',
  'getDouyuRenewalTargets', 'previewDouyuRenewal', 'executeDouyuRenewal', 'cancelDouyuRenewal',
  'getDouyuTasks', 'createDouyuTask', 'setDouyuTaskPolicy', 'startDouyuTask', 'pauseDouyuTask', 'removeDouyuTask', 'retainDouyuTaskRoom', 'closeDouyuTaskRoom',
  'resolveDouyuRoom', 'health', 'verifyAdmin', 'resolve', 'listPresets', 'getPreset', 'savePreset', 'deletePreset',
  'getStylePackSyncState', 'syncStylePacks', 'setStylePackSyncSource',
  'switchQuality', 'stopBuffer', 'reconnectDanmaku', 'login', 'loginStatus', 'logout',
  'getNetworkPreferences', 'setNetworkPreferences',
  'getDecoderPreferences', 'setDecoderPreferences',
  'getToolsStatus', 'getAcquisitionDiagnostics', 'updateYtdlp', 'restoreYtdlp',
])
let nextSubscription = 0

const bridge: StreamSyncerBridge = {
  platform: ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform as 'win32' | 'darwin' | 'linux' : 'unknown',
  invoke<K extends DesktopMethod>(method: K, args: DesktopMethods[K]['args']) {
    if (!methods.has(method)) {
      return Promise.resolve({ ok: false as const, code: 'unknown-method', message: '未知桌面接口' })
    }
    const channel = embeddedLoginMethods.has(method) ? 'stream-syncer:embedded-login-invoke'
      : editorMethods.has(method) ? 'stream-syncer:editor-invoke' : youtubeMethods.has(method) ? 'stream-syncer:yt-invoke' : 'stream-syncer:invoke'
    return ipcRenderer.invoke(channel, method, args) as Promise<ApiResult<DesktopMethods[K]['result']>>
  },
  subscribeDanmaku(room, listener) {
    const subscriptionId = String(++nextSubscription)
    let active = true
    const receive = (_event: unknown, payload: DanmakuEvent & { subscriptionId: string }) => {
      if (active && payload.subscriptionId === subscriptionId) listener({ event: payload.event, data: payload.data })
    }
    ipcRenderer.on('stream-syncer:danmaku', receive)
    // Registration and cancellation use the same ordered invoke channel. A close before
    // subscribe settles still releases the room instead of leaking a pending subscriber.
    void ipcRenderer.invoke('stream-syncer:subscribe', room, subscriptionId).then((result: ApiResult<unknown>) => {
      if (active && !result.ok) listener({ event: 'state', data: { room, state: 'closed', detail: result.message } })
    }).catch(() => {
      if (active) listener({ event: 'state', data: { room, state: 'closed', detail: '弹幕订阅失败' } })
    })
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('stream-syncer:danmaku', receive)
      void ipcRenderer.invoke('stream-syncer:unsubscribe', subscriptionId).catch(() => {})
    }
  },
  subscribeBuffer(listener) {
    let active = true
    const receive = (_event: unknown, state: BufferState) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:buffer', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:buffer', receive) }
  },
  subscribeWindowState(listener) {
    let active = true
    const receive = (_event: unknown, state: WindowState) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:window-state', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:window-state', receive) }
  },
  subscribeDouyuAccounts(listener) {
    let active = true
    const receive = (_event: unknown, state: DouyuAccountsSnapshot) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:douyu-accounts', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:douyu-accounts', receive) }
  },
  subscribeDouyuTasks(listener) {
    let active = true
    const receive = (_event: unknown, state: DouyuTasksSnapshot) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:douyu-tasks', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:douyu-tasks', receive) }
  },
  subscribeFeatures(listener) {
    let active = true
    const receive = (_event: unknown, event: FeatureEvent) => {
      if (active && event && typeof event.topic === 'string') listener(event)
    }
    ipcRenderer.on('stream-syncer:features', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:features', receive) }
  },
  subscribeEmbeddedLogin(listener) {
    let active = true
    const receive = (_event: unknown, state: EmbeddedLoginState | null) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:embedded-login', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:embedded-login', receive) }
  },
  subscribeYtBrowseState(listener) {
    let active = true
    const receive = (_event: unknown, state: YtBrowseState) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:yt-browse-state', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:yt-browse-state', receive) }
  },
  subscribeYtImportProgress(listener) {
    let active = true
    const receive = (_event: unknown, job: YtImportJob) => { if (active) listener(job) }
    ipcRenderer.on('stream-syncer:yt-import-progress', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:yt-import-progress', receive) }
  },
}
contextBridge.exposeInMainWorld('streamSyncer', Object.freeze(bridge))
