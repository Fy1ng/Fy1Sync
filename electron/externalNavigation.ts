import type { WebContents } from 'electron'
import { isAppDocument } from './security'

/** External pages open without inheriting the app window or its preload privileges. */
export function installExternalNavigation(contents: WebContents, openExternal: (url: string) => Promise<unknown>,
  internal: (url: string) => boolean = isAppDocument, onFailure: () => void = () => { console.warn('无法打开外部网页.') }): void {
  const open = (raw: string) => {
    try {
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol) || !isAppDocument(contents.getURL())) return
      void Promise.resolve().then(() => openExternal(url.href)).catch(() => onFailure())
    } catch { /* Unsupported schemes remain outside web navigation. */ }
  }
  contents.setWindowOpenHandler(details => { open(details.url); return { action: 'deny' } })
  const navigate = (event: { preventDefault(): void }, url: string) => {
    if (internal(url)) return
    event.preventDefault()
    open(url)
  }
  contents.on('will-navigate', navigate)
  contents.on('will-redirect', navigate)
}
