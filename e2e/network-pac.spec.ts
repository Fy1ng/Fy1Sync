/** Chromium PAC resolution in an isolated session, followed by real loopback Node transports. */
import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { test, expect } from '@playwright/test'
import { fetch as undiciFetch } from 'undici'
import { mediaRequestPolicy, type ProxyConfig } from '../server/config'
import { NetworkPolicy } from '../server/networkPolicy'
import { safeFetch } from '../server/safeFetch'
import { launchApplication, type RunningApplication } from './electron'

test('隔离 Chromium session 读取真实 PAC, 按路径和 CDN 选择 HTTP/SOCKS5 或直连', async () => {
  const releases: Array<() => Promise<void>> = []
  let running: RunningApplication | undefined
  async function listen(server: Server) {
    const sockets = new Set<Socket>()
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    releases.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
    return { server, port: (server.address() as { port: number }).port }
  }
  const outgoing = new Set<Socket>()
  const pair = (client: Socket, targetPort: number, ready: () => void, head?: Buffer) => {
    const upstream = connect(targetPort, '127.0.0.1')
    outgoing.add(upstream); upstream.once('close', () => outgoing.delete(upstream))
    upstream.on('error', () => client.destroy()); client.once('close', () => upstream.destroy())
    upstream.once('connect', () => { ready(); if (head?.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
  }
  try {
    const received: Array<{ host: string | undefined; path: string | undefined }> = []
    const source = await listen(createHttpServer((request, response) => {
      received.push({ host: request.headers.host, path: request.url })
      response.end(`fixture:${request.url}`)
    }))
    const httpTargets: string[] = []
    const httpServer = createHttpServer()
    httpServer.on('connect', (request, socket, head) => {
      httpTargets.push(request.url!)
      pair(socket as Socket, source.port, () => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'), head)
    })
    const httpProxy = await listen(httpServer)
    const socksTargets: Array<{ host: string; port: number; type: number }> = []
    const socksServer = createServer(socket => {
      let greeting = true, buffered = Buffer.alloc(0)
      const data = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        if (greeting) {
          if (buffered.length < 2 || buffered.length < buffered[1]! + 2) return
          buffered = buffered.subarray(buffered[1]! + 2); greeting = false; socket.write(Buffer.from([5, 0])); return
        }
        if (buffered.length < 5) return
        const type = buffered[3]!, length = type === 3 ? buffered[4]! + 7 : type === 1 ? 10 : 22
        if (buffered.length < length) return
        const host = type === 3 ? buffered.subarray(5, length - 2).toString() : type === 1 ? [...buffered.subarray(4, 8)].join('.') : 'ipv6'
        socksTargets.push({ host, port: buffered.readUInt16BE(length - 2), type })
        const head = buffered.subarray(length)
        socket.removeListener('data', data)
        pair(socket, source.port, () => socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])), head)
      }
      socket.on('data', data)
    })
    const socksProxy = await listen(socksServer)
    const refused = await listen(createServer())
    const candidates = `PROXY 127.0.0.1:${refused.port}; SOCKS5 127.0.0.1:${socksProxy.port}`
    // Chromium retains HTTP paths for PAC. HTTPS paths are intentionally sanitized by Chromium.
    const script = `function FindProxyForURL(url, host) {
      if (host === "cdn.fixture.invalid") return "PROXY 127.0.0.1:${httpProxy.port}";
      if (url.indexOf("/direct") !== -1) return "DIRECT";
      return "${candidates}";
    }`
    let pacReads = 0
    const pac = await listen(createHttpServer((request, response) => {
      if (request.url !== '/routing.pac') { response.writeHead(404).end(); return }
      pacReads++
      response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'cache-control': 'no-store' }).end(script)
    }))
    // Allocate every listener before releasing this port, avoiding accidental reuse.
    await new Promise<void>(resolve => refused.server.close(() => resolve()))
    running = await launchApplication('chromium-pac-loopback')
    const application = running.application
    const partition = `network-pac-${randomUUID()}`
    await application.evaluate(async ({ session }, args) => {
      const isolated = session.fromPartition(args.partition, { cache: false })
      await isolated.setProxy({ mode: 'pac_script', pacScript: args.pacUrl })
      await isolated.forceReloadProxyConfig()
    }, { partition, pacUrl: `http://127.0.0.1:${pac.port}/routing.pac` })
    const decisions = new Map<string, string>()
    const queried: string[] = []
    const network = new NetworkPolicy(async url => {
      queried.push(url)
      const result = await application.evaluate(async ({ session }, args) => session.fromPartition(args.partition).resolveProxy(args.url), { partition, url })
      decisions.set(url, result)
      return result
    }, () => 'system').context('youtube')
    const dnsTargets: string[] = []
    const resolve = async (hostname: string) => { dnsTargets.push(hostname); return ['127.0.0.1'] }
    const config = mediaRequestPolicy({ enabled: true, hosts: [], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 5000 } satisfies ProxyConfig)
    const options = { network, resolve, fetchImpl: undiciFetch as unknown as typeof fetch }
    const proxiedUrl = `http://fixture.invalid:${source.port}/live?fixture=1`
    const cdnUrl = `http://cdn.fixture.invalid:${source.port}/segment.ts?fixture=2`
    const directUrl = `http://fixture.invalid:${source.port}/direct?fixture=3`

    expect(await (await safeFetch(proxiedUrl, config, options)).response.text()).toBe('fixture:/live?fixture=1')
    expect(decisions.get(proxiedUrl)?.split(';').map(value => value.trim())).toEqual(candidates.split(';').map(value => value.trim()))
    expect(socksTargets).toEqual([{ host: 'fixture.invalid', port: source.port, type: 3 }])
    expect(httpTargets).toEqual([])
    expect(dnsTargets).toEqual([])

    expect(await (await safeFetch(cdnUrl, config, options)).response.text()).toBe('fixture:/segment.ts?fixture=2')
    expect(decisions.get(cdnUrl)).toBe(`PROXY 127.0.0.1:${httpProxy.port}`)
    expect(httpTargets).toEqual([`cdn.fixture.invalid:${source.port}`])
    expect(dnsTargets).toEqual([])

    expect(await (await safeFetch(directUrl, config, options)).response.text()).toBe('fixture:/direct?fixture=3')
    expect(decisions.get(directUrl)).toBe('DIRECT')
    expect(dnsTargets).toEqual(['fixture.invalid'])
    expect(queried).toEqual([proxiedUrl, cdnUrl, directUrl])
    expect(received).toEqual([
      { host: `fixture.invalid:${source.port}`, path: '/live?fixture=1' },
      { host: `cdn.fixture.invalid:${source.port}`, path: '/segment.ts?fixture=2' },
      { host: `fixture.invalid:${source.port}`, path: '/direct?fixture=3' },
    ])
    expect(pacReads).toBeGreaterThan(0)
    await application.evaluate(async ({ session }, partitionName) => {
      const isolated = session.fromPartition(partitionName)
      await isolated.closeAllConnections()
      await isolated.clearStorageData()
      await isolated.clearCache()
    }, partition)
  } finally {
    try { await running?.close() }
    finally {
      for (const socket of outgoing) socket.destroy()
      for (const release of releases.reverse()) await release()
    }
  }
})
