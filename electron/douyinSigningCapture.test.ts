import { EventEmitter } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import { captureDouyinSigningSnapshot, DOUYIN_SIGNING_STORAGE_FRAMES } from './douyinSigningCapture'
import { parseDouyinSigningSnapshot } from '../server/douyin/signingMaterial'

const url = 'https://live.douyin.com/'
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const binding = { accountUid: '1234', cookieFingerprint: 'a'.repeat(64), userAgent }
const keys = ['security-sdk/s_sdk_crypt_sdk', 'security-sdk/s_sdk_sign_data_key/web_protect', 'security-sdk/s_sdk_cert_key']
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicJwk = pair.publicKey.export({ format: 'jwk' })
const clientCert = `pub.${Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x!, 'base64url'), Buffer.from(publicJwk.y!, 'base64url')]).toString('base64')}`
const cryptData = JSON.stringify({ ec_privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), ec_publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }), ignored: 'synthetic-secret-not-for-export' })
const serverData = JSON.stringify({ ticket: 'synthetic-ticket', ts_sign: 'ts.2.synthetic-proof', client_cert: clientCert, ignored: 'synthetic-ignored-value' })
const fixture = (crypt = cryptData, server = serverData) => new Map(keys.slice(0, 2).map((key, index) => [key, JSON.stringify({ data: index ? server : crypt })]))
const rootFrame = () => ({ id: 'main', loaderId: 'main-generation', url })

describe('main-only Cookie proof binding',()=>{
  it('pairs an existing SDK private key with the current Cookie proof without injecting that proof into the page',async()=>{
    const f=harness({values:fixture(cryptData,'')})
    const proof=JSON.stringify({ticket:'synthetic-cookie-authoritative',ts_sign:'ts.2.synthetic-proof',client_cert:clientCert})
    const captured=await captureDouyinSigningSnapshot(f.contents,binding,new AbortController().signal,()=>true,{cookieServerData:proof})
    expect(captured).not.toBeNull()
    expect(parseDouyinSigningSnapshot(captured!).ticket).toBe('synthetic-cookie-authoritative')
    expect(f.calls.filter(value=>value.method==='Runtime.evaluate').some(value=>String(value.params?.expression).includes('synthetic-cookie-authoritative'))).toBe(false)
  })
  it('rejects a Cookie certificate mismatch instead of falling back to a stale SDK proof',async()=>{
    const f=harness()
    const proof=JSON.stringify({ticket:'synthetic-cookie-current',ts_sign:'ts.2.synthetic-proof',client_cert:'pub.wrong'})
    expect(await captureDouyinSigningSnapshot(f.contents,binding,new AbortController().signal,()=>true,{cookieServerData:proof})).toBeNull()
  })
})

async function existingDb(values: Map<string, string>): Promise<IDBFactory> {
  const factory = new IDBFactory()
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('secure-store', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('cryptvalues')
      for (const [key, value] of values) store.put(value, key)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => { request.result.close(); resolve() }
  })
  return factory
}

function harness(options: { values?: Map<string, string>; idb?: IDBFactory; frameUrl?: string; mainUrl?: string; response?: unknown } = {}) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const reads: string[] = []
  const transactions: string[] = []
  const debuggerEvents = new EventEmitter()
  let activeUrl = options.mainUrl ?? url
  let frameUrl = options.frameUrl ?? activeUrl
  let loaderId = 'main-generation'
  let evaluateHook: (() => Promise<void> | void) | undefined
  let frameTreeHook: (() => void) | undefined
  const values = options.values ?? fixture()
  const idb = options.idb ?? new IDBFactory()
  const open = vi.fn((name: string, version?: number) => {
    const request = idb.open(name, version)
    request.addEventListener('success', () => {
      const db = request.result
      const transaction = db.transaction.bind(db)
      db.transaction = ((names: string | string[], mode?: IDBTransactionMode) => {
        transactions.push(`${names}:${mode}`)
        if (names !== 'cryptvalues' || mode !== 'readonly') throw new Error('write-forbidden')
        const tx = transaction(names, mode)
        const objectStore = tx.objectStore.bind(tx)
        tx.objectStore = ((name: string) => {
          const store = objectStore(name)
          const get = store.get.bind(store)
          store.get = ((key: IDBValidKey) => {
            reads.push(`idb:${key}`)
            if (!keys.includes(String(key))) throw new Error('extra-key-forbidden')
            return get(key)
          }) as typeof store.get
          for (const method of ['put', 'add', 'delete', 'clear', 'getAll', 'getAllKeys', 'openCursor', 'openKeyCursor'] as const) {
            store[method] = (() => { throw new Error('write-or-scan-forbidden') }) as never
          }
          return store
        }) as typeof tx.objectStore
        return tx
      }) as typeof db.transaction
    })
    return request
  })
  const debug = Object.assign(debuggerEvents, {
    isAttached: () => true,
    attach: vi.fn(() => { throw new Error('attach-forbidden') }),
    detach: vi.fn(() => { throw new Error('detach-forbidden') }),
    sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'Page.getFrameTree') {
        frameTreeHook?.()
        return { frameTree: { frame: { ...rootFrame(), url: activeUrl, loaderId },
          ...(options.frameUrl ? { childFrames: [{ frame: { id: 'bridge', parentId: 'main', loaderId: 'bridge-generation', url: frameUrl } }] } : {}) } }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: params?.frameId === 'main' ? 1 : 2 }
      if (method === 'Runtime.evaluate') {
        await evaluateHook?.()
        if ('response' in options) return options.response
        const evaluationUrl = params?.contextId === 2 ? frameUrl : activeUrl
        const result = await runInNewContext(String(params?.expression), {
          location: { href: evaluationUrl }, setTimeout, clearTimeout,
          localStorage: {
            getItem(key: string) {
              reads.push(`local:${key}`)
              if (!keys.includes(key)) throw new Error('extra-key-forbidden')
              if (options.frameUrl && params?.contextId === 1) return null
              return values.get(key) ?? null
            },
            setItem() { throw new Error('write-forbidden') },
            removeItem() { throw new Error('write-forbidden') },
            clear() { throw new Error('write-forbidden') },
            key() { throw new Error('scan-forbidden') },
          },
          indexedDB: {
            databases: () => idb.databases(), open,
            deleteDatabase() { throw new Error('write-forbidden') },
          },
        })
        return { result: { type: typeof result === 'string' ? 'string' : 'object', value: result } }
      }
      throw new Error('unexpected-cdp-command')
    }),
  })
  const contents = { getURL: () => activeUrl, getUserAgent: () => userAgent, debugger: debug } as unknown as Parameters<typeof captureDouyinSigningSnapshot>[0]
  return {
    contents, calls, reads, transactions, open, debug, values,
    setMainUrl(value: string) { activeUrl = value },
    setFrameUrl(value: string) { frameUrl = value },
    setLoader(value: string) { loaderId = value },
    onEvaluate(hook: () => Promise<void> | void) { evaluateHook = hook },
    onFrameTree(hook: () => void) { frameTreeHook = hook },
    capture(signal = new AbortController().signal, current?: () => boolean) { return captureDouyinSigningSnapshot(contents, binding, signal, current) },
  }
}

describe('passive Douyin signing capture', () => {
  it('reads only the fixed localStorage keys, validates the pair and strips unrelated fields', async () => {
    const page = harness()
    const snapshot = await page.capture()
    expect(snapshot).not.toBeNull()
    expect(parseDouyinSigningSnapshot(snapshot!).clientCertificate).toBe(clientCert)
    expect(JSON.stringify(snapshot)).not.toContain('ignored')
    expect(page.reads).toEqual([...keys, ...keys].map(key => `local:${key}`))
    expect(page.open).not.toHaveBeenCalled()
    expect(page.calls.map(call => call.method)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree'])
    expect(page.calls[1]?.params).toMatchObject({ grantUniveralAccess: false })
    expect(page.debug.listenerCount('message')).toBe(0)
    expect(page.debug.attach).not.toHaveBeenCalled()
    expect(page.debug.detach).not.toHaveBeenCalled()
  })

  it('reads existing exact IDB records in one readonly transaction without scanning data', async () => {
    const idb = await existingDb(fixture())
    const page = harness({ values: new Map(), idb })
    const snapshot = await page.capture()
    expect(snapshot).not.toBeNull()
    expect(page.open).toHaveBeenCalledExactlyOnceWith('secure-store', 1)
    expect(page.transactions).toEqual(['cryptvalues:readonly'])
    expect(page.reads.filter(key => key.startsWith('idb:'))).toEqual(keys.map(key => `idb:${key}`))
  })

  it('does not create a missing database and does not open unrelated databases', async () => {
    const idb = new IDBFactory()
    const request = idb.open('unrelated-secret-store', 1)
    await new Promise<void>(resolve => { request.onsuccess = () => { request.result.close(); resolve() } })
    const page = harness({ values: new Map(), idb })
    expect(await page.capture()).toBeNull()
    expect(page.open).not.toHaveBeenCalled()
    expect((await idb.databases()).map(db => db.name)).toEqual(['unrelated-secret-store'])
  })

  it('aborts an upgrade if the selected database disappears between metadata and open', async () => {
    const idb = await existingDb(fixture())
    const metadata = idb.databases.bind(idb)
    const databaseSpy = vi.spyOn(idb, 'databases').mockImplementationOnce(async () => {
      const databases = await metadata()
      await new Promise<void>(resolve => { const request = idb.deleteDatabase('secure-store'); request.onsuccess = () => resolve() })
      return databases
    })
    const page = harness({ values: new Map(), idb })
    expect(await page.capture()).toBeNull()
    expect(page.open).toHaveBeenCalledExactlyOnceWith('secure-store', 1)
    databaseSpy.mockRestore()
    expect(await idb.databases()).toEqual([])
    expect(page.transactions).toEqual([])
  })

  it.each(DOUYIN_SIGNING_STORAGE_FRAMES)('reads an existing official bridge with an isolated world: %s', async frameUrl => {
    const page = harness({ frameUrl })
    expect(await page.capture()).not.toBeNull()
    expect(page.calls.filter(call => call.method === 'Page.createIsolatedWorld').map(call => call.params?.frameId)).toEqual(['main', 'bridge'])
  })

  it.each([
    'https://lf-zt.douyin.com/obj/uc-assets/zt/@byted/x-storage-web/other/dist/latest/index.html',
    'https://www.douyin.com/unrelated/index.html',
    'https://www.douyin.com/ucenter/security/storage-bridge/index.html?extra=credential',
    'https://www.douyin.com/ucenter/security/storage-bridge/index.html?t=1&t=2',
    'https://www.douyin.com/ucenter/security/storage-bridge/index.html#changed',
    'https://www.douyin.com.evil.example/ucenter/security/storage-bridge/index.html',
  ])('rejects an unknown bridge without evaluating it: %s', async frameUrl => {
    const page = harness({ frameUrl })
    expect(await page.capture()).toBeNull()
    expect(page.calls.filter(call => call.method === 'Runtime.evaluate')).toHaveLength(1)
  })

  it('reads the official login page that signed the account in, still binding the material to the live origin', async () => {
    const page = harness({ mainUrl: 'https://www.douyin.com/login_page?service=https%3A%2F%2Flive.douyin.com%2F' })
    const snapshot = await page.capture()
    expect(snapshot).not.toBeNull()
    expect(snapshot!.origin).toBe('https://live.douyin.com')
    expect(parseDouyinSigningSnapshot(snapshot!).clientCertificate).toBe(clientCert)
  })

  it.each(['https://live.douyin.com.evil.example/', 'https://www.douyin.com/', 'http://live.douyin.com/', 'https://live.douyin.com/login',
    'https://www.douyin.com/login_page/next', 'http://www.douyin.com/login_page', 'https://user@www.douyin.com/login_page',
    'https://login.douyin.com/login_page', 'https://www.douyin.com.evil.example/login_page'])('does not read storage on an unapproved main page: %s', async mainUrl => {
    const page = harness({ mainUrl })
    expect(await page.capture()).toBeNull()
    expect(page.calls).toEqual([])
  })

  it('rejects missing private material without generating or repairing keys', async () => {
    const page = harness({ values: fixture('{}') })
    expect(await page.capture()).toBeNull()
    expect(page.calls.every(call => ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'].includes(call.method))).toBe(true)
    const expression = String(page.calls.find(call => call.method === 'Runtime.evaluate')?.params?.expression)
    expect(expression).not.toMatch(/\.setItem\(|\.put\(|\.getAll\(|\.openCursor\(|getKeysInfo|_checkCryptKeys|\.init\(|generateKey|document\.cookie|fetch\(|XMLHttpRequest/)
  })

  it('rejects a mismatched ticket certificate instead of combining incompatible records', async () => {
    const page = harness({ values: fixture(cryptData, serverData.replace(clientCert, 'pub.invalid')) })
    expect(await page.capture()).toBeNull()
  })

  it('rejects oversized or unexpected responses without returning any page exception', async () => {
    for (const response of [
      { result: { type: 'string', value: 'x'.repeat(196609) } },
      { exceptionDetails: { text: cryptData }, result: { type: 'string', value: cryptData } },
      { result: { type: 'string', value: JSON.stringify({ url, bundles: [{ cryptData, serverData, certificate: '', credential: 'secret' }] }) } },
    ]) expect(await harness({ response }).capture()).toBeNull()
  })

  it('rejects a stale login generation and mismatched user agent before reading', async () => {
    const page = harness()
    expect(await page.capture(undefined, () => false)).toBeNull()
    expect(await captureDouyinSigningSnapshot(page.contents, { ...binding, userAgent: `${userAgent} stale` }, new AbortController().signal)).toBeNull()
    expect(page.calls).toEqual([])
  })

  it('rejects an invalid account binding before touching private storage', async () => {
    const page = harness()
    for (const invalid of [{ ...binding, accountUid: '0' }, { ...binding, accountUid: '18446744073709551616' }, { ...binding, cookieFingerprint: 'invalid' }]) {
      expect(await captureDouyinSigningSnapshot(page.contents, invalid, new AbortController().signal)).toBeNull()
    }
    expect(page.calls).toEqual([])
  })

  it('discards data if the login generation becomes stale while evaluation is pending', async () => {
    const page = harness()
    let current = true
    page.onEvaluate(() => { current = false })
    expect(await page.capture(undefined, () => current)).toBeNull()
    expect(page.calls.filter(call => call.method === 'Page.getFrameTree')).toHaveLength(1)
  })

  it('rejects loader changes even if navigation returns to the same URL', async () => {
    const page = harness()
    let gets = 0
    page.onFrameTree(() => { if (++gets === 2) page.setLoader('new-generation') })
    expect(await page.capture()).toBeNull()
  })

  it('invalidates navigation events and frame URL changes during the read', async () => {
    const page = harness()
    page.onEvaluate(() => { page.debug.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } }) })
    expect(await page.capture()).toBeNull()
    const bridge = harness({ frameUrl: DOUYIN_SIGNING_STORAGE_FRAMES[1] })
    bridge.onEvaluate(() => { bridge.setFrameUrl('https://evil.example/') })
    expect(await bridge.capture()).toBeNull()
  })

  it('returns promptly on cancellation without accepting a late result or detaching the broker', async () => {
    const page = harness()
    const controller = new AbortController()
    let release!: () => void
    page.onEvaluate(() => new Promise<void>(resolve => { release = resolve }))
    const capture = page.capture(controller.signal)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort()
    expect(await capture).toBeNull()
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(page.calls.filter(call => call.method === 'Page.getFrameTree')).toHaveLength(1)
    expect(page.debug.listenerCount('message')).toBe(0)
    expect(page.debug.detach).not.toHaveBeenCalled()
  })

  it('bounds a stalled CDP read by the overall deadline and removes its listener', async () => {
    vi.useFakeTimers()
    try {
      const page = harness()
      page.debug.sendCommand.mockImplementation(() => new Promise(() => {}))
      const capture = page.capture()
      await vi.advanceTimersByTimeAsync(6000)
      expect(await capture).toBeNull()
      expect(page.debug.listenerCount('message')).toBe(0)
      expect(page.debug.detach).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
