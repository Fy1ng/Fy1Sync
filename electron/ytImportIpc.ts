import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { trustedSender } from './ipc'
import { isAppDocument } from './security'
import type { YouTubeBrowseManager } from './ytBrowse'
import { MAX_YT_IMPORT_SECONDS, type YouTubeImportJobManager } from './ytImport'

export function isAdminDocument(raw: string): boolean {
  try { return isAppDocument(raw) && ['/admin', '/admin/'].includes(new URL(raw).pathname) } catch { return false }
}

const messages: Record<string, string> = {
  'invalid-arguments': '参数无效.', 'bot-challenge': 'YouTube 要求机器人验证, 请更新已保存的登录.',
  'auth-required': '请使用现有登录流程重新登录 YouTube.', 'geo-restricted': '该录像在当前地区不可用.',
  'video-unavailable': '该录像不可用.', 'live-not-supported': '暂不支持下载仍在直播的录像片段.',
  'format-unavailable': '所选画质不可用或无法无损封装, 未改用其他画质.', 'provider-failed': 'YouTube 验证工具不可用.',
  network: '网络请求失败, 请检查系统代理.', 'rate-limited': 'YouTube 请求被限流, 请稍后重试.',
  'disk-full': '片段估算超过 40GiB 或磁盘剩余空间不足.', 'too-long': '单段长度不能超过 3 小时.',
  cancelled: '操作已取消.', busy: '已有下载正在运行.', 'not-open': '请先打开 YouTube 录像.',
  'capture-failed': '截图失败, 请等待画面加载稳定后重试.', 'ad-playing': '广告播放期间不能截图.',
  'snapshot-too-large': '画面尺寸超出 8K, 无法截取.', 'navigation-blocked': '已阻止不允许的页面导航.',
  'not-ready': '视频尚未加载完成.', 'snapshot-unavailable': '画面尚未稳定或视频内容未完整显示, 请重试.',
  'origin-tainted': '读不到视频画面，YouTube 可能换了播放方式',
  'player-only-failed': '无法只显示播放器，请重新打开录像',
  closed: 'YouTube 浏览窗口已关闭.',
}

/** Never serialize arbitrary upstream exceptions, paths, cookie values or signed URLs. */
function failure(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && Object.hasOwn(messages, error.code) ? error.code : 'internal-error'
  return { ok: false as const, code, message: messages[code] ?? 'YouTube 操作失败, 请重试.' }
}

function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const names = Reflect.ownKeys(value)
  return names.every(key => typeof key === 'string' && [...required, ...optional].includes(key)
    && descriptors[key] && 'value' in descriptors[key]!) && required.every(key => Object.hasOwn(descriptors, key))
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** One explicit native owner, its top frame and the active admin document are required. */
export function installYouTubeAdminIpc(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, owner: WebContents, options: {
  ownerWindow: BrowserWindow
  browse: Pick<YouTubeBrowseManager, 'open' | 'close' | 'command' | 'state' | 'snapshot' | 'setViewport'>
  imports: Pick<YouTubeImportJobManager, 'start' | 'cancel' | 'list' | 'cancelAll'>
  offline?: boolean
  blocked?: () => boolean
}) {
  let disposed = false
  let generation = 0
  let leaving: Promise<void> = Promise.resolve()
  const allowed = () => !disposed && !owner.isDestroyed() && isAdminDocument(owner.mainFrame.url)
  const reset = (): Promise<void> => {
    generation++
    const pending = Promise.allSettled([options.browse.close(), options.imports.cancelAll()]).then(() => {})
    leaving = Promise.all([leaving, pending]).then(() => {})
    return leaving
  }
  const navigated = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && (!inPlace || !isAdminDocument(url))) void reset()
  }
  const inPage = (_event: unknown, url: string, mainFrame: boolean) => { if (mainFrame && !isAdminDocument(url)) void reset() }
  const destroyed = () => { void reset() }
  owner.on('did-start-navigation', navigated)
  owner.on('did-navigate-in-page', inPage)
  owner.once('destroyed', destroyed)
  const denied = () => ({ ok: false as const, code: 'forbidden', message: '仅允许当前 admin 窗口调用.' })
  ipc.handle('stream-syncer:yt-invoke', async (event: IpcMainInvokeEvent, method: unknown, args: unknown) => {
    if (!allowed() || !trustedSender(event, owner)) return denied()
    const revision = generation
    const current = () => allowed() && revision === generation && trustedSender(event, owner)
    try {
      await leaving
      if (!current()) return denied()
      let value: unknown
      switch (method) {
        case 'ytBrowseOpen':
          if (!fields(args, ['url']) || typeof args.url !== 'string' || args.url.length > 2048) throw { code: 'invalid-arguments' }
          if (options.offline) throw { code: 'network' }
          if (options.blocked?.()) throw { code: 'auth-required' }
          value = await options.browse.open(options.ownerWindow, args.url)
          break
        case 'ytBrowseClose':
          if (args !== undefined) throw { code: 'invalid-arguments' }
          await options.browse.close(); value = { ok: true }
          break
        case 'ytBrowseState':
        case 'ytBrowseSnapshot':
          if (args !== undefined) throw { code: 'invalid-arguments' }
          value = method === 'ytBrowseState' ? await options.browse.state() : await options.browse.snapshot()
          break
        case 'ytBrowseCommand':
          if (!fields(args, ['action'], ['seconds']) || typeof args.action !== 'string' || !['play', 'pause', 'seek'].includes(args.action)
            || (args.action === 'seek' ? !finite(args.seconds) || args.seconds < 0 || args.seconds > 604800 : args.seconds !== undefined)) throw { code: 'invalid-arguments' }
          value = await options.browse.command(args as unknown as Parameters<YouTubeBrowseManager['command']>[0])
          break
        case 'ytBrowseSetViewport':
          if (!fields(args, ['rect', 'visible']) || typeof args.visible !== 'boolean'
            || !fields(args.rect, ['x', 'y', 'width', 'height'])
            || !finite(args.rect.x) || Math.abs(args.rect.x) > 10000
            || !finite(args.rect.y) || Math.abs(args.rect.y) > 10000
            || !finite(args.rect.width) || args.rect.width < 0 || args.rect.width > 10000
            || !finite(args.rect.height) || args.rect.height < 0 || args.rect.height > 10000) throw { code: 'invalid-arguments' }
          options.browse.setViewport(args as unknown as Parameters<YouTubeBrowseManager['setViewport']>[0]); value = { ok: true }
          break
        case 'ytImportStart':
          if (!fields(args, ['url', 'startSeconds', 'endSeconds', 'targetHeight']) || typeof args.url !== 'string' || args.url.length > 2048
            || !finite(args.targetHeight) || ![2160, 1440, 1080].includes(args.targetHeight)
            || !finite(args.startSeconds) || !finite(args.endSeconds) || args.startSeconds < 0 || args.endSeconds <= args.startSeconds) throw { code: 'invalid-arguments' }
          if (args.endSeconds - args.startSeconds > MAX_YT_IMPORT_SECONDS) throw { code: 'too-long' }
          if (options.offline) throw { code: 'network' }
          if (options.blocked?.()) throw { code: 'auth-required' }
          if (options.imports.list().some(job => job.state === 'probing' || job.state === 'downloading')) throw { code: 'busy' }
          value = options.imports.start(args as unknown as Parameters<YouTubeImportJobManager['start']>[0])
          break
        case 'ytImportCancel':
          if (!fields(args, ['jobId']) || typeof args.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.jobId)) throw { code: 'invalid-arguments' }
          value = await options.imports.cancel(args.jobId) ?? null
          break
        case 'ytImportList':
          if (args !== undefined) throw { code: 'invalid-arguments' }
          value = options.imports.list()
          break
        default: return { ok: false, code: 'unknown-method', message: '未知 YouTube 接口.' }
      }
      return current() ? { ok: true, value } : denied()
    } catch (error) { return current() ? failure(error) : denied() }
  })
  return {
    reset,
    emit(channel: 'yt-browse-state' | 'yt-import-progress', payload: unknown, ownerId = owner.id): boolean {
      if (ownerId !== owner.id || !allowed()) return false
      try { owner.send(`stream-syncer:${channel}`, payload); return true } catch { return false }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      owner.removeListener('did-start-navigation', navigated)
      owner.removeListener('did-navigate-in-page', inPage)
      owner.removeListener('destroyed', destroyed)
      ipc.removeHandler('stream-syncer:yt-invoke')
      await reset()
    },
  }
}
