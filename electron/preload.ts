import { contextBridge, ipcRenderer } from 'electron'
import type { StreamSyncerBridge, DesktopMethod, DesktopMethods, DanmakuEvent } from './contracts'
import type { ApiResult } from '../src/app/apiClient'
import type { BufferState } from './bufferManager'
import type { DouyuTasksSnapshot } from '../server/douyu/types'

const methods = new Set<DesktopMethod>([
  'listDouyuAccounts', 'addDouyuAccount', 'renameDouyuAccount', 'loginDouyuAccount', 'loginDouyuYubaAccount', 'activateDouyuAccount', 'logoutDouyuAccount', 'removeDouyuAccount',
  'sendDouyuMessage',
  'getDouyuTasks', 'createDouyuTask', 'setDouyuTaskPolicy', 'startDouyuTask', 'pauseDouyuTask', 'removeDouyuTask', 'retainDouyuTaskRoom', 'closeDouyuTaskRoom',
  'resolveDouyuRoom', 'health', 'verifyAdmin', 'resolve', 'listPresets', 'getPreset', 'savePreset', 'deletePreset',
  'switchQuality', 'stopBuffer', 'login', 'loginStatus', 'logout',
  'getDecoderPreferences', 'setDecoderPreferences',
  'getToolsStatus', 'updateYtdlp', 'restoreYtdlp',
])
let nextSubscription = 0

const bridge: StreamSyncerBridge = {
  invoke<K extends DesktopMethod>(method: K, args: DesktopMethods[K]['args']) {
    if (!methods.has(method)) {
      return Promise.resolve({ ok: false as const, code: 'unknown-method', message: '未知桌面接口' })
    }
    return ipcRenderer.invoke('stream-syncer:invoke', method, args) as Promise<ApiResult<DesktopMethods[K]['result']>>
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
  subscribeDouyuTasks(listener) {
    let active = true
    const receive = (_event: unknown, state: DouyuTasksSnapshot) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:douyu-tasks', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:douyu-tasks', receive) }
  },
}
contextBridge.exposeInMainWorld('streamSyncer', Object.freeze(bridge))
