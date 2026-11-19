import type { IpcMain, WebContents } from 'electron'
import { trustedSender } from './ipc'
import { BrowserImportError } from './browserImportError'
import type { BrowserLoginImport } from './browserLoginImport'

export function installBrowserImportIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, owner: WebContents, imports: BrowserLoginImport): () => void {
  const channel = 'stream-syncer:browser-import-invoke'
  ipc.handle(channel, async (event, method: unknown, args: unknown) => {
    if (!trustedSender(event, owner)) return { ok: false, code: 'forbidden', message: '仅允许应用主窗口导入浏览器登录态' }
    try {
      let value: unknown
      if (method === 'listBrowserImportProfiles' && args === undefined) value = await imports.sources()
      else if (method === 'previewBrowserLogins') value = await imports.scan(args)
      else if (method === 'importBrowserLogins') value = await imports.apply(args)
      else if (method === 'cancelBrowserImport' && args && typeof args === 'object' && !Array.isArray(args)
        && Object.keys(args).length === 1 && Object.hasOwn(args, 'id')) value = imports.cancel((args as { id: unknown }).id)
      else throw new BrowserImportError('browser-import-invalid-request')
      if (!trustedSender(event, owner)) { imports.release(); return { ok: false, code: 'forbidden', message: '导入窗口已关闭' } }
      return { ok: true, value }
    } catch (error) {
      const safe = error instanceof BrowserImportError ? error : new BrowserImportError('browser-import-verification-failed')
      return { ok: false, code: safe.code, message: safe.message }
    }
  })
  const release = () => imports.release()
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) release() }
  owner.on('did-start-navigation', navigation)
  owner.once('destroyed', release)
  return () => { imports.release(); ipc.removeHandler(channel); owner.removeListener('did-start-navigation', navigation); owner.removeListener('destroyed', release) }
}
