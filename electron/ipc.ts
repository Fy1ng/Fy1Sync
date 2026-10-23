import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesktopService } from '../server/api'
import { parseDouyuRoom } from '../server/platforms'
import { isAppDocument } from './security'

/** Trust both the concrete app window and its top frame, never just a claimed URL. */
export function trustedSender(event: IpcMainInvokeEvent, contents: WebContents): boolean {
  return !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame &&
    event.senderFrame !== null && isAppDocument(event.senderFrame.url)
}

export function installIpcHandlers(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, contents: WebContents, service: DesktopService) {
  const subscriptions = new Map<string, { room: string | null; release: () => void }>()
  let disposed = false
  const denied = () => ({ ok: false, code: 'forbidden', message: '仅允许本机应用窗口调用' })
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9]{1,12}$/.test(id)
  const send = (subscriptionId: string, event: string, data: unknown) => {
    if (!disposed && !contents.isDestroyed() && isAppDocument(contents.mainFrame.url)) contents.send('stream-syncer:danmaku', { subscriptionId, event, data })
  }
  const clear = () => { for (const entry of subscriptions.values()) entry.release(); subscriptions.clear() }
  const releaseBuffer = service.subscribeBuffer?.((state) => {
    if (!contents.isDestroyed() && isAppDocument(contents.mainFrame.url)) contents.send('stream-syncer:buffer', state)
  })
  ipc.handle('stream-syncer:invoke', (event, method: unknown, args: unknown) => {
    if (disposed || !trustedSender(event, contents)) return denied()
    return service.invoke(method, args)
  })
  ipc.handle('stream-syncer:subscribe', async (event, room: unknown, subscriptionId: unknown) => {
    if (disposed || !trustedSender(event, contents)) return denied()
    if (!validId(subscriptionId) || typeof room !== 'string' || room.length > 8192 || !parseDouyuRoom(room)) {
      return { ok: false, code: 'bad-room', message: '房间号或订阅标识无效' }
    }
    if (subscriptions.has(subscriptionId) || subscriptions.size >= 16) return { ok: false, code: 'subscription-limit', message: '订阅数量超过限制' }
    // Reserve before awaiting identity, so cancellation and duplicate IDs cover pending work.
    const entry = { room: null as string | null, release: () => {} }
    subscriptions.set(subscriptionId, entry)
    const current = () => !disposed && subscriptions.get(subscriptionId) === entry && trustedSender(event, contents)
    try {
      const result = await service.resolveDouyuRoom(room)
      if (!current()) {
        if (subscriptions.get(subscriptionId) === entry) subscriptions.delete(subscriptionId)
        return { ok: false, code: 'subscription-cancelled', message: '弹幕订阅已取消' }
      }
      if (!result.ok) {
        subscriptions.delete(subscriptionId)
        return { ok: false, code: result.failure.code, message: result.failure.message }
      }
      const canonical = result.identity.room
      entry.room = canonical
      send(subscriptionId, 'state', { room: canonical, state: 'connecting' })
      const release = service.relay.subscribe(canonical, {
        write: (event, data) => { if (current()) send(subscriptionId, event, data) },
        close: () => { if (current()) send(subscriptionId, 'state', { room: canonical, state: 'closed' }) },
      })
      if (!release) {
        subscriptions.delete(subscriptionId)
        return { ok: false, code: 'room-limit', message: '订阅房间数量超过限制' }
      }
      entry.release = release
      return { ok: true, value: { ok: true, room: canonical } }
    } catch {
      if (subscriptions.get(subscriptionId) === entry) subscriptions.delete(subscriptionId)
      return { ok: false, code: 'upstream-error', message: '弹幕房间身份查询失败, 请重试' }
    }
  })
  ipc.handle('stream-syncer:unsubscribe', (event, subscriptionId: unknown) => {
    if (disposed || !trustedSender(event, contents)) return denied()
    if (!validId(subscriptionId)) return { ok: false, code: 'bad-subscription', message: '订阅标识无效' }
    subscriptions.get(subscriptionId)?.release()
    subscriptions.delete(subscriptionId)
    return { ok: true, value: { ok: true } }
  })
  const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !inPlace) clear()
  }
  contents.on('did-start-navigation', navigated)
  contents.once('destroyed', clear)
  return {
    dispose() {
      disposed = true
      releaseBuffer?.()
      clear()
      contents.removeListener('did-start-navigation', navigated)
      contents.removeListener('destroyed', clear)
      for (const channel of ['stream-syncer:invoke', 'stream-syncer:subscribe', 'stream-syncer:unsubscribe']) ipc.removeHandler(channel)
    },
    emitDanmaku(room: string, event: string, data: unknown): number {
      let delivered = 0
      for (const [id, entry] of subscriptions) if (entry.room === room) { send(id, event, data); delivered++ }
      return delivered
    },
  }
}
