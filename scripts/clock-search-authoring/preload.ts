import { contextBridge, ipcRenderer } from 'electron'
import type { ClockSearchAuthorApi } from './authorStore'

async function request(channel: 'clock-search-author:get-state' | 'clock-search-author:save', args?: unknown) {
  try { return await ipcRenderer.invoke(channel, args) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  }
}
const api: ClockSearchAuthorApi = {
  getState: () => request('clock-search-author:get-state'),
  save: roi => request('clock-search-author:save', roi),
}
contextBridge.exposeInMainWorld('clockSearchAuthor', Object.freeze(api))
