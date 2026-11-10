import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { EmbeddedLoginController } from './embeddedLogin'
import { parseLoginCardAction } from './loginCardValidation'

/** Only the current local card's exact top frame can send credentials. */
export function installLoginCardIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  controller: Pick<EmbeddedLoginController, 'ownsCard' | 'cardState' | 'cardAction'>): () => void {
  let disposed = false
  ipc.handle('stream-syncer:login-card', async (event: IpcMainInvokeEvent, method: unknown, value: unknown) => {
    if (disposed || !controller.ownsCard(event.sender, event.senderFrame)) return { ok: false, message: '登录页面已失效.' }
    if (method === 'state') return value === undefined ? controller.cardState() : null
    if (method !== 'action') return { ok: false, message: '不支持的登录操作.' }
    const action = parseLoginCardAction(value)
    if (!action) return { ok: false, message: '请检查登录输入.' }
    try { return await controller.cardAction(action) }
    catch { return { ok: false, message: '登录操作未完成, 请重试.' } }
  })
  return () => { disposed = true; ipc.removeHandler('stream-syncer:login-card') }
}
