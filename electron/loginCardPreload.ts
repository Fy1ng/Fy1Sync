import { contextBridge, ipcRenderer } from 'electron'
import type { LoginCardBridge, LoginCardState } from './loginCardContracts'

/** This preload exists only in the local, network-disabled credential card. */
const bridge: LoginCardBridge = {
  state: () => ipcRenderer.invoke('stream-syncer:login-card', 'state'),
  act: action => ipcRenderer.invoke('stream-syncer:login-card', 'action', action),
  subscribe(listener) {
    let active = true
    const receive = (_event: unknown, state: LoginCardState) => { if (active) listener(state) }
    ipcRenderer.on('stream-syncer:login-card-state', receive)
    return () => { active = false; ipcRenderer.removeListener('stream-syncer:login-card-state', receive) }
  },
}
contextBridge.exposeInMainWorld('loginCard', Object.freeze(bridge))
