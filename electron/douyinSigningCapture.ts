import type { WebContents } from 'electron'
import {
  DOUYIN_SIGNING_ORIGIN,
  parseDouyinSigningSnapshot,
  type DouyinSigningCaptureContext,
  type DouyinSigningSnapshot,
} from '../server/douyin/signingMaterial'

// Fixed URLs and storage schema from the official 2722.06f25cc9.js SDK snapshot.
// Do not accept a caller-supplied origin, namespace, storage key or JavaScript.
export const DOUYIN_SIGNING_STORAGE_FRAMES = [
  'https://live.douyin.com/ucenter/security/storage-bridge/index.html',
  'https://www.douyin.com/ucenter/security/storage-bridge/index.html',
  'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.5/dist/page/index.html',
  'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/4.0.5/dist/latest/index.html',
] as const

const STORAGE_KEYS = [
  'security-sdk/s_sdk_crypt_sdk',
  'security-sdk/s_sdk_sign_data_key/web_protect',
  'security-sdk/s_sdk_cert_key',
] as const
const MAX_VALUE = 32768
const MAX_RESPONSE = 196608
const MAX_FRAMES = 8
const MAX_TREE_FRAMES = 64
const CAPTURE_TIMEOUT = 6000

type CaptureContents = Pick<WebContents, 'getURL' | 'getUserAgent' | 'debugger'>
interface Frame { id: string; loaderId: string; url: string; parentId?: string }
interface FrameTree { frame: Frame; childFrames?: FrameTree[] }
interface StorageBundle { cryptData: string; serverData: string; certificate: string }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function mainPageAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === DOUYIN_SIGNING_ORIGIN && url.pathname === '/' && !url.username && !url.password
  } catch { return false }
}

function storageFrameAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash || !DOUYIN_SIGNING_STORAGE_FRAMES.includes(`${url.origin}${url.pathname}` as typeof DOUYIN_SIGNING_STORAGE_FRAMES[number])) return false
    // The SDK adds only a millisecond retry timestamp to its existing bridge URL.
    return !url.search || [...url.searchParams].length === 1 && /^\d{1,16}$/.test(url.searchParams.get('t') || '')
  } catch { return false }
}

function framesFrom(value: unknown): Frame[] {
  const root = record(value).frameTree as FrameTree | undefined
  if (!root || !mainPageAllowed(root.frame?.url || '')) return []
  const frames: Frame[] = []
  const visit = (tree: FrameTree, depth: number): void => {
    if (depth > 8 || frames.length >= MAX_TREE_FRAMES || !tree || !tree.frame) throw new Error('capture-frame-limit')
    const { id, loaderId, url, parentId } = tree.frame
    if (typeof id !== 'string' || !id || id.length > 128 || typeof loaderId !== 'string' || !loaderId || loaderId.length > 128
      || typeof url !== 'string' || url.length > 2048) throw new Error('capture-frame-invalid')
    frames.push({ id, loaderId, url, ...(parentId ? { parentId } : {}) })
    for (const child of tree.childFrames || []) visit(child, depth + 1)
  }
  visit(root, 0)
  return frames
}

/** Only native storage getters run in an isolated world; no SDK initialization or repair runs. */
function storageReadExpression(url: string): string {
  return `(${async function (expectedUrl: string, keys: readonly string[], maximum: number) {
    const samePage = () => location.href === expectedUrl
    if (!samePage()) return null
    let closed = false
    const unwrap = (raw: unknown): string => {
      if (typeof raw !== 'string' || raw.length > maximum) return ''
      try {
        const value = JSON.parse(raw)
        return value && typeof value === 'object' && typeof value.data === 'string' && value.data.length <= maximum ? value.data : ''
      } catch { return '' }
    }
    const bundle = (values: string[]) => ({ cryptData: values[0] || '', serverData: values[1] || '', certificate: values[2] || '' })
    const bundles: ReturnType<typeof bundle>[] = []
    try {
      const values = keys.map(key => localStorage.getItem(key))
      if (samePage() && keys.every((key, index) => localStorage.getItem(key) === values[index])) bundles.push(bundle(values.map(unwrap)))
    } catch { /* A disabled storage backend is an ordinary missing-material result. */ }
    if (!samePage()) return null
    try {
      // Metadata prevents open() from creating a missing database. Other databases are never opened.
      // Older engines without databases() simply retain the localStorage result.
      if (typeof indexedDB.databases === 'function') {
        const databases = await indexedDB.databases()
        if (databases.length > 64 || !samePage()) return null
        const existing = databases.find(item => item.name === 'secure-store')
        if (existing && Number.isSafeInteger(existing.version) && existing.version! > 0) {
          const values = await new Promise<string[]>(resolve => {
            let db: IDBDatabase | undefined
            let done = false
            const finish = (values: string[] = []) => {
              if (done) return
              done = true
              clearTimeout(timer)
              db?.close()
              resolve(values)
            }
            const timer = setTimeout(() => { closed = true; finish() }, 1200)
            const request = indexedDB.open('secure-store', existing.version)
            // A database deleted between metadata and open must never be recreated.
            request.onupgradeneeded = () => { request.transaction?.abort(); finish() }
            request.onerror = request.onblocked = () => finish()
            request.onsuccess = () => {
              db = request.result
              if (done) { db.close(); return }
              if (!samePage() || !db.objectStoreNames.contains('cryptvalues')) { finish(); return }
              try {
                const transaction = db.transaction('cryptvalues', 'readonly')
                const store = transaction.objectStore('cryptvalues')
                const result = keys.map(() => '')
                keys.forEach((key, index) => {
                  const read = store.get(key)
                  read.onsuccess = () => { result[index] = unwrap(read.result) }
                })
                transaction.oncomplete = () => finish(result)
                transaction.onerror = transaction.onabort = () => finish()
              } catch { finish() }
            }
          })
          if (!closed && samePage() && values.length === 3) bundles.push(bundle(values))
        }
      }
    } catch { /* Never return storage exceptions or page-controlled error messages. */ }
    if (!samePage()) return null
    return JSON.stringify({ url: expectedUrl, bundles })
  }.toString()})(${JSON.stringify(url)},${JSON.stringify(STORAGE_KEYS)},${MAX_VALUE})`
}

function readBundles(value: unknown, url: string): StorageBundle[] {
  if (typeof value !== 'string' || value.length > MAX_RESPONSE) return []
  try {
    const data = record(JSON.parse(value))
    if (data.url !== url || !Array.isArray(data.bundles) || data.bundles.length > 2) return []
    return data.bundles.map(value => {
      const data = record(value)
      if (Object.keys(data).some(key => !['cryptData', 'serverData', 'certificate'].includes(key))
        || !['cryptData', 'serverData', 'certificate'].every(key => typeof data[key] === 'string' && (data[key] as string).length <= MAX_VALUE)) throw new Error('capture-value-invalid')
      return data as unknown as StorageBundle
    })
  } catch { return [] }
}

function snapshotFrom(bundle: StorageBundle, context: DouyinSigningCaptureContext, cookieServerData?: string): DouyinSigningSnapshot | null {
  try {
    const crypt = record(JSON.parse(bundle.cryptData)), sign = record(JSON.parse(cookieServerData ?? bundle.serverData))
    if (typeof crypt.ec_privateKey !== 'string' || typeof crypt.ec_publicKey !== 'string') return null
    // Keep only the fields used by the private signing parser. Arbitrary stored data never escapes.
    const snapshot: DouyinSigningSnapshot = {
      ...context, origin: DOUYIN_SIGNING_ORIGIN,
      cryptData: JSON.stringify({ ec_privateKey: crypt.ec_privateKey, ec_publicKey: crypt.ec_publicKey }),
      serverData: JSON.stringify({ ticket: sign.ticket, ts_sign: sign.ts_sign, client_cert: sign.client_cert,
        ...(typeof sign.aes_sign_safari === 'string' ? { aes_sign_safari: sign.aes_sign_safari } : {}) }),
      ...(bundle.certificate.startsWith('-----BEGIN CERTIFICATE-----') && bundle.certificate.length <= 16384 ? { certificate: bundle.certificate } : {}),
    }
    parseDouyinSigningSnapshot(snapshot)
    return snapshot
  } catch { return null }
}

/** Capture an already existing, matched SDK bundle for main-process use only. */
export async function captureDouyinSigningSnapshot(
  contents: CaptureContents,
  context: DouyinSigningCaptureContext,
  signal: AbortSignal,
  current: () => boolean = () => true,
  options: {cookieServerData?: string} = {},
): Promise<DouyinSigningSnapshot | null> {
  let invalidated = false
  let frames: Frame[] = []
  const debug = contents.debugger
  // Copy the authenticated binding before the first await; callers cannot mutate it mid-capture.
  const binding = { accountUid: context.accountUid, cookieFingerprint: context.cookieFingerprint, userAgent: context.userAgent }
  // Cookie proof remains in main and is never injected into another frame's isolated world.
  const cookieServerData=options.cookieServerData
  if (cookieServerData!==undefined && (typeof cookieServerData!=='string' || cookieServerData.length>MAX_VALUE)) return null
  if (typeof binding.accountUid !== 'string' || !/^[1-9]\d{0,19}$/.test(binding.accountUid) || BigInt(binding.accountUid) > 0xffff_ffff_ffff_ffffn
    || typeof binding.cookieFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(binding.cookieFingerprint) || typeof binding.userAgent !== 'string'
    || binding.userAgent.length > 512 || /[\x00-\x1f\x7f]/.test(binding.userAgent)) return null
  const valid = () => !invalidated && !signal.aborted && current() && mainPageAllowed(contents.getURL())
    && contents.getUserAgent() === binding.userAgent && debug.isAttached()
  let cancel!: () => void
  const interrupted = new Promise<null>(resolve => { cancel = () => { invalidated = true; resolve(null) } })
  const onMessage = (_event: unknown, method: string, parameters: Record<string, unknown>, sessionId?: string) => {
    if (sessionId) return
    if (['Page.frameNavigated', 'Page.frameDetached', 'Page.frameStartedLoading', 'Page.navigatedWithinDocument'].includes(method)) {
      const id = method === 'Page.frameNavigated' ? record(parameters.frame).id : parameters.frameId
      if (frames.some(frame => frame.id === id)) cancel()
    }
  }
  const timer = setTimeout(cancel, CAPTURE_TIMEOUT)
  signal.addEventListener('abort', cancel, { once: true })
  debug.on('message', onMessage)
  try {
    const capture = async (): Promise<DouyinSigningSnapshot | null> => {
      if (!valid()) return null
      frames = framesFrom(await debug.sendCommand('Page.getFrameTree'))
      if (!valid() || !frames.length) return null
      const candidates = frames.filter((frame, index) => index === 0 || storageFrameAllowed(frame.url))
      if (candidates.length > MAX_FRAMES) return null
      for (const frame of candidates) {
        if (!valid()) return null
        const world = record(await debug.sendCommand('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'fy1sync-douyin-signing-readonly', grantUniveralAccess: false }))
        if (!valid() || !Number.isSafeInteger(world.executionContextId) || (world.executionContextId as number) <= 0) return null
        const result = record(await debug.sendCommand('Runtime.evaluate', {
          expression: storageReadExpression(frame.url), contextId: world.executionContextId,
          awaitPromise: true, returnByValue: true, silent: true, timeout: 1800,
        }))
        if (!valid() || result.exceptionDetails) return null
        const remote = record(result.result)
        if (remote.type !== 'string') continue
        for (const bundle of readBundles(remote.value, frame.url)) {
          const snapshot = snapshotFrom(bundle, binding,cookieServerData)
          if (!snapshot) continue
          const latest = framesFrom(await debug.sendCommand('Page.getFrameTree'))
          // A navigation away and back is also rejected by loader identity and Page events.
          if (!valid() || latest[0]?.id !== frames[0]?.id || latest[0]?.loaderId !== frames[0]?.loaderId
            || !latest.some(item => item.id === frame.id && item.loaderId === frame.loaderId && item.url === frame.url)) return null
          return snapshot
        }
      }
      return null
    }
    // The losing read task is allowed to finish passively. It cannot detach the broker or publish late data.
    return await Promise.race([capture().catch(() => null), interrupted])
  } catch { return null }
  finally {
    invalidated = true
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    debug.removeListener('message', onMessage)
  }
}
