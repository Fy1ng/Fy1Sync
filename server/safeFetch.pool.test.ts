import { describe, expect, it, vi } from 'vitest'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'
import { metadataConfig } from './config'
import { createServer } from 'node:http'
import { connect, createServer as createNetServer, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { DEFAULT_MEDIA_NETWORK } from './mediaNetworkOptions'

const scheduleUrl = 'https://schedule.fy1ng.cn/v1/cs2/schedule'

describe('service-owned pinned connection pool', () => {
  it('reuses one actual socket and decodes gzip without disabling address pinning', async () => {
    let connections = 0
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/json' })
      response.end(gzipSync('{"fixture":true}'))
    })
    server.on('connection', () => { connections++ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const pool = new PinnedDispatcherPool()
    try {
      const config = { ...metadataConfig(), hosts: ['fixture.invalid'], allowNonStandardPorts: true }
      for (let index = 0; index < 2; index++) {
        const result = await safeFetch(`http://fixture.invalid:${address.port}/`, config, { dispatcherPool: pool, resolve: async () => ['127.0.0.1'], headers: { 'Accept-Encoding': 'gzip' } })
        expect(await result.response.json()).toEqual({ fixture: true })
      }
      expect(connections).toBe(1)
    } finally {
      await pool.dispose()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('reuses a validated connection and repins when DNS changes', async () => {
    const pool = new PinnedDispatcherPool()
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
    let addresses = ['93.184.216.34']
    const options = { dispatcherPool: pool, resolve: async () => addresses, fetchImpl: request }
    try {
      await (await safeFetch(scheduleUrl, metadataConfig(), options)).response.text()
      await (await safeFetch(scheduleUrl, metadataConfig(), options)).response.text()
      const dispatcher = (index: number) => (request.mock.calls[index]![1] as RequestInit & { dispatcher: unknown }).dispatcher
      expect(dispatcher(0)).toBe(dispatcher(1))
      addresses = ['93.184.216.35']
      await (await safeFetch(scheduleUrl, metadataConfig(), options)).response.text()
      expect(dispatcher(2)).not.toBe(dispatcher(1))
      addresses = ['127.0.0.1']
      await (await safeFetch(scheduleUrl, metadataConfig(), options)).response.text()
      expect(dispatcher(3)).not.toBe(dispatcher(2))
      addresses = ['not-an-ip']
      await expect(safeFetch(scheduleUrl, metadataConfig(), options)).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(4)
    } finally { await pool.dispose() }
  })
  it('rejects use after disposal', async () => {
    const pool = new PinnedDispatcherPool()
    await pool.dispose()
    await expect(safeFetch(scheduleUrl, metadataConfig(), {
      dispatcherPool: pool, resolve: async () => ['93.184.216.34'], fetchImpl: async () => new Response('{}'),
    })).rejects.toThrow('Network service closed')
  })

  it('reuses pooled HTTP and SOCKS5 proxy tunnels under DEFAULT_MEDIA_NETWORK (requestTimeoutMs=0)', async () => {
    const sockets = new Set<Socket>()
    const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
    const target = createServer((_request, response) => response.end('proxied-pooled'))
    target.on('connection', track)
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve))
    const targetPort = (target.address() as { port: number }).port

    let httpTunnels = 0
    const httpProxy = createServer()
    httpProxy.on('connection', track)
    httpProxy.on('connect', (_request, socket, head) => {
      httpTunnels++
      const upstream = connect(targetPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
      })
      track(upstream)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })
    await new Promise<void>(resolve => httpProxy.listen(0, '127.0.0.1', resolve))
    const httpProxyPort = (httpProxy.address() as { port: number }).port

    let socksTunnels = 0
    const socksProxy = createNetServer(socket => {
      track(socket)
      let greeting = true
      let buffered = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        if (greeting) {
          if (buffered.length < 2 || buffered.length < buffered[1]! + 2) return
          buffered = buffered.subarray(buffered[1]! + 2)
          greeting = false
          socket.write(Buffer.from([5, 0]))
          return
        }
        if (buffered.length < 5) return
        const atyp = buffered[3]!
        const length = atyp === 3 ? buffered[4]! + 7 : atyp === 1 ? 10 : 22
        if (buffered.length < length) return
        const remaining = buffered.subarray(length)
        socket.removeListener('data', onData)
        socksTunnels++
        const upstream = connect(targetPort, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (remaining.length) upstream.write(remaining)
          socket.pipe(upstream).pipe(socket)
        })
        track(upstream)
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }
      socket.on('data', onData)
    })
    await new Promise<void>(resolve => socksProxy.listen(0, '127.0.0.1', resolve))
    const socksPort = (socksProxy.address() as { port: number }).port

    const pool = new PinnedDispatcherPool({ connections: 2 })
    try {
      const config = { ...metadataConfig(), hosts: ['fixture.invalid'], allowNonStandardPorts: true }
      for (const route of [
        { kind: 'http' as const, proxyUrl: `http://127.0.0.1:${httpProxyPort}` },
        { kind: 'socks5' as const, proxyUrl: `socks5://127.0.0.1:${socksPort}` },
      ]) {
        const network = { route: async () => route, media: DEFAULT_MEDIA_NETWORK }
        for (let i = 0; i < 3; i++) {
          const result = await safeFetch(`http://fixture.invalid:${targetPort}/${i}`, config, { dispatcherPool: pool, network })
          expect(await result.response.text()).toBe('proxied-pooled')
          // Let Undici return the completed socket to the idle pool before the next sequential fetch.
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
      expect(httpTunnels).toBe(1)
      expect(socksTunnels).toBe(1)
    } finally {
      await pool.dispose()
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, httpProxy, socksProxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    }
  })
})
