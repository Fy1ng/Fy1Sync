import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkSocket } from './networkSocket'
import { installNetworkPolicy, NetworkPolicy, type NetworkContext, type NetworkRoute } from '../networkPolicy'

const mocks = vi.hoisted(() => {
  const sockets: Array<{ binaryType?: string; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; fire(type: string, event?: unknown): void }> = []
  const dispatchers: Array<{ destroy: ReturnType<typeof vi.fn> }> = []
  const dispatcher = () => { const value = { destroy: vi.fn(async () => {}) }; dispatchers.push(value); return value }
  return {
    sockets, dispatchers,
    proxy: vi.fn(function (_options: unknown) { return dispatcher() }),
    pinned: vi.fn((_hostname: string, _addresses: readonly string[]) => dispatcher()),
    websocket: vi.fn(function (_url: string, _options: unknown) {
      const listeners = new Map<string, (event: unknown) => void>()
      const socket = { send: vi.fn(), close: vi.fn(), binaryType: '',
        addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener) },
        fire: (type: string, event = {}) => { listeners.get(type)?.(event) },
      }
      sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), ProxyAgent: mocks.proxy, WebSocket: mocks.websocket }))
vi.mock('../safeFetch', async importOriginal => ({ ...await importOriginal<typeof import('../safeFetch')>(), createPinnedDispatcher: mocks.pinned }))

const douyu = 'wss://danmuproxy.douyu.com:8506/'
const huya = 'wss://cdnws.api.huya.com/'
const direct: NetworkContext = { route: async () => ({ kind: 'direct' }) }
const proxied: NetworkContext = { route: async () => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:7890/' }) }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
afterEach(() => { mocks.sockets.length = 0; mocks.dispatchers.length = 0; vi.clearAllMocks() })

describe('platform danmaku network transport', () => {
  it.each([{ platform: 'douyu', url: douyu }, { platform: 'huya', url: huya }] as const)
    ('uses guarded pinned DNS for direct $platform connections', async ({ platform, url }) => {
      const resolve = vi.fn(async () => ['8.8.8.8'])
      const socket = createNetworkSocket(url, platform, { network: direct, resolve })
      await flush()
      expect(resolve).toHaveBeenCalledExactlyOnceWith(new URL(url).hostname)
      expect(mocks.pinned).toHaveBeenCalledExactlyOnceWith(new URL(url).hostname, ['8.8.8.8'])
      expect(mocks.proxy).not.toHaveBeenCalled()
      expect(mocks.websocket).toHaveBeenCalledWith(url, { dispatcher: mocks.dispatchers[0] })
      socket.close()
      expect(mocks.dispatchers[0]!.destroy).toHaveBeenCalledOnce()
    })

  it('uses HTTP proxy without local target DNS and retains certificate checks', async () => {
    const resolve = vi.fn(async () => { throw new Error('must not resolve locally') })
    const socket = createNetworkSocket(douyu, 'douyu', { network: proxied, resolve })
    await flush()
    expect(resolve).not.toHaveBeenCalled()
    expect(mocks.pinned).not.toHaveBeenCalled()
    expect(mocks.proxy).toHaveBeenCalledExactlyOnceWith({ uri: 'http://127.0.0.1:7890/', requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } })
    socket.close()
  })

  it('captures each connection policy and reads changed domestic settings for the next connection', async () => {
    let mode: 'direct' | 'system' = 'direct'
    const resolveProxy = vi.fn(async () => 'PROXY 127.0.0.1:7890')
    installNetworkPolicy(new NetworkPolicy(resolveProxy, () => mode))
    const first = createNetworkSocket(huya, 'huya', { resolve: async () => ['8.8.8.8'] })
    mode = 'system'
    await flush()
    expect(mocks.proxy).not.toHaveBeenCalled()
    expect(resolveProxy).not.toHaveBeenCalled()
    const second = createNetworkSocket(huya, 'huya', { resolve: async () => { throw new Error('local DNS forbidden in proxy branch') } })
    await flush()
    expect(resolveProxy).toHaveBeenCalledWith(huya)
    expect(mocks.proxy).toHaveBeenCalledOnce()
    first.close(); second.close()
  })

  it.each([
    'wss://outside.example:8506/', 'ws://danmuproxy.douyu.com:8506/', 'wss://danmuproxy.douyu.com/',
    'wss://user:password@danmuproxy.douyu.com:8506/', 'wss://danmuproxy.douyu.com:8506/?cookie=secret',
    'wss://danmuproxy.douyu.com:8506/unexpected', 'wss://cdnws.api.huya.com/',
  ])('rejects unexpected endpoints before proxy resolution: %s', url => {
    const route = vi.fn(async (): Promise<NetworkRoute> => ({ kind: 'http', proxyUrl: 'http://127.0.0.1:7890' }))
    expect(() => createNetworkSocket(url, 'douyu', { network: { route } })).toThrow('弹幕连接地址不在允许范围内.')
    expect(route).not.toHaveBeenCalled()
    expect(mocks.websocket).not.toHaveBeenCalled()
  })

  it('rejects direct private DNS results before transport creation', async () => {
    const error = vi.fn()
    const socket = createNetworkSocket(douyu, 'douyu', { network: direct, resolve: async () => ['127.0.0.1'] })
    socket.addEventListener('error', error)
    await flush()
    expect(error).toHaveBeenCalledWith({ message: '弹幕网络连接失败, 请检查出网设置.' })
    expect(mocks.websocket).not.toHaveBeenCalled()
  })

  it('buffers listener registration and binaryType, forwards frames and releases on close', async () => {
    const socket = createNetworkSocket(huya, 'huya', { network: proxied })
    const open = vi.fn(), message = vi.fn(), close = vi.fn()
    socket.addEventListener('open', open)
    socket.addEventListener('message', message)
    socket.addEventListener('close', close)
    socket.binaryType = 'blob'
    expect(() => socket.send(new Uint8Array())).toThrow('弹幕连接尚未就绪.')
    await flush()
    const transport = mocks.sockets[0]!
    expect(transport.binaryType).toBe('blob')
    transport.fire('open')
    const data = new Uint8Array([1, 2, 3])
    transport.fire('message', { data })
    socket.send(data)
    expect(open).toHaveBeenCalledOnce()
    expect(message).toHaveBeenCalledWith({ data })
    expect(transport.send).toHaveBeenCalledWith(data)
    transport.fire('close', { code: 1000, wasClean: true, reason: 'cookie=private signed?token=private' })
    expect(close).toHaveBeenCalledWith({ code: 1000, wasClean: true, reason: '弹幕连接已断开.' })
    expect(mocks.dispatchers[0]!.destroy).toHaveBeenCalledOnce()
    socket.close()
    expect(mocks.dispatchers[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('cancels pending routing and DNS before opening a transport', async () => {
    let finishRoute!: (route: NetworkRoute) => void
    const resolve = vi.fn(async () => ['8.8.8.8'])
    const socket = createNetworkSocket(douyu, 'douyu', { network: { route: () => new Promise(yes => { finishRoute = yes }) }, resolve })
    socket.close()
    finishRoute({ kind: 'direct' })
    await flush()
    expect(resolve).not.toHaveBeenCalled()
    expect(mocks.websocket).not.toHaveBeenCalled()
    let finishDns!: (value: string[]) => void
    const duringDns = createNetworkSocket(douyu, 'douyu', { network: direct, resolve: () => new Promise(yes => { finishDns = yes }) })
    await flush()
    duringDns.close()
    finishDns(['8.8.8.8'])
    await flush()
    expect(mocks.websocket).not.toHaveBeenCalled()
  })

  it('masks proxy and TLS errors and releases the dispatcher once', async () => {
    const socket = createNetworkSocket(douyu, 'douyu', { network: proxied })
    const error = vi.fn(), close = vi.fn()
    socket.addEventListener('error', error)
    socket.addEventListener('close', close)
    await flush()
    mocks.sockets[0]!.fire('error', { message: 'certificate cookie=private https://signed.invalid/?token=private' })
    mocks.sockets[0]!.fire('close', { reason: 'private' })
    expect(error).toHaveBeenCalledExactlyOnceWith({ message: '弹幕网络连接失败, 请检查出网设置.' })
    expect(close).toHaveBeenCalledOnce()
    expect(JSON.stringify([error.mock.calls, close.mock.calls])).not.toContain('private')
    expect(mocks.dispatchers[0]!.destroy).toHaveBeenCalledOnce()
  })
})
