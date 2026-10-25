import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { DesktopService } from '../server/api'
import { parseDouyuRoom } from '../server/platforms'
import type { FeatureEvent } from './featureContracts'
import { isAppDocument } from './security'

/** Trust both the concrete app window and its top frame, never just a claimed URL or ID. */
export function trustedSender(event: IpcMainInvokeEvent, contents: WebContents): boolean {
  try {
    return !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame &&
      event.senderFrame !== null && isAppDocument(event.senderFrame.url)
  } catch { return false }
}

export interface IpcHandlerOptions {
  extraContents?: readonly WebContents[]
  /** Additional windows need an explicit grant; the primary window remains trusted. */
  allowMethod?: (senderId: number, method: string, args: unknown) => boolean
  allowRoom?: (senderId: number, room: string) => boolean
  /** Buffer/task notifications use the topics "buffer" and "douyu-tasks". */
  allowEvent?: (senderId: number, event: FeatureEvent) => boolean
}
interface WindowEntry { contents: WebContents; generation: number; unregister: () => void; detach: () => void }
interface Subscription { owner: WindowEntry; id: string; room: string | null; release: () => void }

/** Install one set of handlers and explicitly register each additional native window. */
export function installIpcHandlers(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, contents: WebContents,
  service: DesktopService, options: IpcHandlerOptions = {}) {
  const windows = new Map<number, WindowEntry>()
  const subscriptions = new Map<string, Subscription>()
  let disposed = false
  let taskRoom: string | null = null
  const denied = () => ({ ok: false as const, code: 'forbidden', message: '仅允许已授权的本机应用窗口调用' })
  const cancelled = () => ({ ok: false as const, code: 'subscription-cancelled', message: '弹幕订阅已取消' })
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9]{1,12}$/.test(id)
  const keyFor = (owner: WindowEntry, id: string) => owner.contents.id + ':' + id
  const registered = (owner: WindowEntry) => !disposed && windows.get(owner.contents.id) === owner
  const safeRelease = (release: (() => void) | undefined) => { try { release?.() } catch { /* Continue releasing other owners. */ } }
  const permits = (owner: WindowEntry, grant: (() => boolean) | undefined): boolean => {
    if (!registered(owner)) return false
    if (owner.contents === contents) return true
    try { return grant?.() === true } catch { return false }
  }
  const allowMethod = (owner: WindowEntry, method: unknown, args: unknown) =>
    permits(owner, typeof method === 'string' && options.allowMethod ? (() => options.allowMethod!(owner.contents.id, method, args)) : undefined)
  const allowRoom = (owner: WindowEntry, room: string) =>
    permits(owner, options.allowRoom && (() => options.allowRoom!(owner.contents.id, room)))
  const allowEvent = (owner: WindowEntry, event: FeatureEvent) =>
    permits(owner, options.allowEvent && (() => options.allowEvent!(owner.contents.id, event)))
  const sender = (event: IpcMainInvokeEvent): WindowEntry | undefined => {
    try {
      const owner = windows.get(event.sender.id)
      return owner && registered(owner) && trustedSender(event, owner.contents) ? owner : undefined
    } catch { return undefined }
  }
  const send = (owner: WindowEntry, channel: string, data: unknown): boolean => {
    try {
      if (!registered(owner) || owner.contents.isDestroyed() || !isAppDocument(owner.contents.mainFrame.url)) return false
      owner.contents.send(channel, data)
      return true
    } catch { return false }
  }
  const sendDanmaku = (entry: Subscription, room: string, event: string, data: unknown): boolean =>
    allowRoom(entry.owner, room) && send(entry.owner, 'stream-syncer:danmaku', { subscriptionId: entry.id, event, data })
  const broadcast = (channel: string, event: FeatureEvent, payload: unknown) => {
    for (const owner of windows.values()) if (allowEvent(owner, event)) send(owner, channel, payload)
  }
  const syncTaskRoom = () => {
    // Insertion order records subscription/activation intent even when lookups finish out of order.
    let next: string | null = null
    if (!disposed) for (const entry of subscriptions.values()) if (entry.room !== null) next = entry.room
    if (next === taskRoom) return
    service.setDouyuRoom?.(next)
    taskRoom = next
  }
  const clear = (owner?: WindowEntry) => {
    const removed: Subscription[] = []
    for (const [key, entry] of subscriptions) if (!owner || entry.owner === owner) {
      subscriptions.delete(key)
      removed.push(entry)
    }
    for (const entry of removed) safeRelease(entry.release)
    safeRelease(syncTaskRoom)
  }
  function registerWindow(window: WebContents): () => void {
    if (disposed) return () => {}
    if (!Number.isSafeInteger(window.id) || window.id < 1 || window.isDestroyed()) throw new Error('Cannot register an invalid or destroyed app window')
    const previous = windows.get(window.id)
    if (previous) {
      if (previous.contents !== window) throw new Error('A different app window already owns this ID')
      return previous.unregister
    }
    const owner: WindowEntry = { contents: window, generation: 0, unregister: () => {}, detach: () => {} }
    const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) { owner.generation++; clear(owner) }
    }
    const unregister = () => {
      if (windows.get(window.id) !== owner) return
      windows.delete(window.id)
      owner.generation++
      owner.detach()
      clear(owner)
    }
    owner.unregister = unregister
    owner.detach = () => {
      window.removeListener('did-start-navigation', navigated)
      window.removeListener('destroyed', unregister)
    }
    windows.set(window.id, owner)
    window.on('did-start-navigation', navigated)
    window.once('destroyed', unregister)
    return unregister
  }
  registerWindow(contents)
  for (const window of options.extraContents ?? []) registerWindow(window)

  const releaseBuffer = service.subscribeBuffer?.(state => broadcast('stream-syncer:buffer', { topic: 'buffer', data: state }, state))
  const releaseDouyuTasks = service.subscribeDouyuTasks?.(state => broadcast('stream-syncer:douyu-tasks', { topic: 'douyu-tasks', data: state }, state))
  const releaseFeatures = service.subscribeFeatures?.(event => broadcast('stream-syncer:features', event, event))

  ipc.handle('stream-syncer:invoke', async (event, method: unknown, args: unknown) => {
    const owner = sender(event)
    if (!owner || !allowMethod(owner, method, args)) return denied()
    const generation = owner.generation
    const current = () => sender(event) === owner && owner.generation === generation && allowMethod(owner, method, args)
    if (method === 'activateDouyuRoom') {
      // This operation cannot be implemented in the service: only IPC knows subscription ownership.
      const descriptor = args && typeof args === 'object' && !Array.isArray(args)
        && Reflect.ownKeys(args).length === 1 ? Object.getOwnPropertyDescriptor(args, 'room') : undefined
      const room = descriptor && 'value' in descriptor ? descriptor.value : undefined
      if (typeof room !== 'string' || !/^[1-9][0-9]{0,11}$/.test(room)) return { ok: false, code: 'invalid-arguments', message: '房间参数无效' }
      if (!allowRoom(owner, room)) return denied()
      const selected = [...subscriptions.entries()].find(([, entry]) => entry.owner === owner && entry.room === room)
      if (!selected) return { ok: false, code: 'room-not-subscribed', message: '请先在当前窗口完成该房间的弹幕订阅' }
      if (!service.setDouyuRoom) return { ok: false, code: 'not-available', message: '房间任务服务尚不可用' }
      subscriptions.delete(selected[0])
      subscriptions.set(selected[0], selected[1])
      try { syncTaskRoom() } catch { return { ok: false, code: 'internal-error', message: '无法切换当前操作房间' } }
      return current() ? { ok: true, value: { room } } : denied()
    }
    try {
      const result = await service.invoke(method, args, Object.freeze({ senderId: owner.contents.id }))
      return current() ? result : denied()
    } catch { return { ok: false, code: 'internal-error', message: '本地服务无法完成此操作' } }
  })
  ipc.handle('stream-syncer:subscribe', async (event, room: unknown, subscriptionId: unknown) => {
    const owner = sender(event)
    if (!owner) return denied()
    if (!validId(subscriptionId) || typeof room !== 'string' || room.length > 8192 || !parseDouyuRoom(room)) {
      return { ok: false, code: 'bad-room', message: '房间号或订阅标识无效' }
    }
    if (!allowRoom(owner, parseDouyuRoom(room)!)) return denied()
    const key = keyFor(owner, subscriptionId)
    const ownedCount = [...subscriptions.values()].filter(entry => entry.owner === owner).length
    if (subscriptions.has(key) || ownedCount >= 16) return { ok: false, code: 'subscription-limit', message: '订阅数量超过限制' }
    // Reserve before awaiting identity, so cancellation and duplicate IDs cover pending work.
    const entry: Subscription = { owner, id: subscriptionId, room: null, release: () => {} }
    subscriptions.set(key, entry)
    const generation = owner.generation
    const current = () => subscriptions.get(key) === entry && owner.generation === generation && sender(event) === owner
    const discard = () => {
      if (subscriptions.get(key) === entry) subscriptions.delete(key)
      safeRelease(entry.release)
      safeRelease(syncTaskRoom)
    }
    try {
      const result = await service.resolveDouyuRoom(room)
      if (!current()) { discard(); return cancelled() }
      if (!result.ok) {
        discard()
        return { ok: false, code: result.failure.code, message: result.failure.message }
      }
      const canonical = result.identity.room
      if (!allowRoom(owner, canonical)) { discard(); return denied() }
      sendDanmaku(entry, canonical, 'state', { room: canonical, state: 'connecting' })
      const release = service.relay.subscribe(canonical, {
        write: (event, data) => { if (current()) sendDanmaku(entry, canonical, event, data) },
        close: () => { if (current()) sendDanmaku(entry, canonical, 'state', { room: canonical, state: 'closed' }) },
      })
      if (!release) { discard(); return { ok: false, code: 'room-limit', message: '订阅房间数量超过限制' } }
      let released = false
      entry.release = () => { if (!released) { released = true; release() } }
      if (!current() || !allowRoom(owner, canonical)) { discard(); return cancelled() }
      entry.room = canonical
      syncTaskRoom()
      return { ok: true, value: { ok: true, room: canonical } }
    } catch {
      discard()
      return { ok: false, code: 'upstream-error', message: '弹幕房间身份查询失败, 请重试' }
    }
  })
  ipc.handle('stream-syncer:unsubscribe', (event, subscriptionId: unknown) => {
    const owner = sender(event)
    if (!owner) return denied()
    if (!validId(subscriptionId)) return { ok: false, code: 'bad-subscription', message: '订阅标识无效' }
    if (owner.contents !== contents && !options.allowRoom) return denied()
    const key = keyFor(owner, subscriptionId), entry = subscriptions.get(key)
    subscriptions.delete(key)
    safeRelease(entry?.release)
    try { syncTaskRoom() } catch { return { ok: false, code: 'internal-error', message: '弹幕订阅已释放, 但操作房间更新失败' } }
    return { ok: true, value: { ok: true } }
  })
  return {
    registerWindow,
    dispose() {
      if (disposed) return
      disposed = true
      safeRelease(releaseBuffer)
      safeRelease(releaseDouyuTasks)
      safeRelease(releaseFeatures)
      for (const owner of windows.values()) { owner.generation++; owner.detach() }
      windows.clear()
      clear()
      for (const channel of ['stream-syncer:invoke', 'stream-syncer:subscribe', 'stream-syncer:unsubscribe']) ipc.removeHandler(channel)
    },
    emitDanmaku(room: string, event: string, data: unknown): number {
      let delivered = 0
      for (const entry of subscriptions.values()) if (entry.room === room && sendDanmaku(entry, room, event, data)) delivered++
      return delivered
    },
  }
}
