import type { IpcMain, WebContents } from 'electron'
import { trustedSender } from './ipc'
import { isAppDocument } from './security'
import { loginAttemptId, loginViewport } from './embeddedLoginPolicy'
import type { EmbeddedLoginController } from './embeddedLogin'

/** Remote login frames never enter this owner-scoped IPC boundary. */
export function installEmbeddedLoginIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, owner: WebContents,
  controller: Pick<EmbeddedLoginController, 'state' | 'subscribe' | 'setViewport' | 'cancel' | 'retry' | 'back'>): () => void {
  let disposed = false
  const allowed = () => !disposed && !owner.isDestroyed() && isAppDocument(owner.mainFrame.url)
  const release = controller.subscribe(state => { if (allowed()) owner.send('stream-syncer:embedded-login', state) })
  const invalid = () => ({ ok: false as const, code: 'invalid-arguments', message: '登录卡片参数无效' })
  const denied = () => ({ ok: false as const, code: 'forbidden', message: '仅允许应用主窗口控制登录卡片' })
  ipc.handle('stream-syncer:embedded-login-invoke', async (event, method: unknown, args: unknown) => {
    if (!allowed() || !trustedSender(event, owner)) return denied()
    if (method === 'getEmbeddedLogin') return args === undefined ? { ok: true, value: controller.state() } : invalid()
    if (method === 'setEmbeddedLoginViewport') {
      const viewport = loginViewport(args)
      if (!viewport) return invalid()
      controller.setViewport(viewport)
      return { ok: true, value: { ok: true } }
    }
    if (method !== 'cancelEmbeddedLogin' && method !== 'retryEmbeddedLogin' && method !== 'backEmbeddedLogin') return invalid()
    const id = loginAttemptId(args)
    if (!id) return invalid()
    try {
      if (method === 'cancelEmbeddedLogin') await controller.cancel(id)
      else if (method === 'backEmbeddedLogin') await controller.back(id)
      else await controller.retry(id)
      return allowed() && trustedSender(event, owner) ? { ok: true, value: { ok: true } } : denied()
    } catch { return { ok: false, code: 'login-failed', message: '登录页面暂时不可用, 请重试.' } }
  })
  return () => { disposed = true; release(); ipc.removeHandler('stream-syncer:embedded-login-invoke') }
}
