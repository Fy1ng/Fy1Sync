import { createServer, type RequestListener } from 'node:http'
import { createServer as createTlsServer } from 'node:tls'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from './config'
import { safeFetch } from './safeFetch'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const config = {
  ...resolveConfig({}).proxy, hosts: ['localhost', 'fixture.invalid'],
  // Local fixtures exercise the transport without exposing a production opt-out.
  allowNonStandardPorts: true, allowNonLoopbackTargets: true, requestTimeoutMs: 3_000,
}

async function listen(host: string, handler: RequestListener, port = 0) {
  const server = createServer(handler)
  const peers = new Set<Socket>()
  server.on('connection', peer => { peers.add(peer); peer.on('close', () => peers.delete(peer)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  cleanups.push(async () => {
    for (const peer of peers) peer.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener has no address')
  return { port: address.port, peers }
}

describe('safeFetch actual DNS-bound connections', () => {
  it('connects to the validated address, preserves Host and isolates later DNS results', async () => {
    const firstHosts: Array<string | undefined> = []
    const secondHosts: Array<string | undefined> = []
    const first = await listen('127.0.0.1', (request, response) => { firstHosts.push(request.headers.host); response.end('first') })
    const second = await listen('127.0.0.2', (request, response) => { secondHosts.push(request.headers.host); response.end('second') }, first.port)
    const resolve = vi.fn(async () => ['127.0.0.2'])
    const target = `http://localhost:${first.port}/fixture`
    const response = await safeFetch(target, config, { resolve })
    expect(await response.response.text()).toBe('second')
    expect(firstHosts).toEqual([])
    expect(secondHosts).toEqual([`localhost:${first.port}`])
    expect(resolve).toHaveBeenCalledExactlyOnceWith('localhost')
    resolve.mockResolvedValue(['127.0.0.1'])
    const next = await safeFetch(target, config, { resolve })
    expect(await next.response.text()).toBe('first')
    expect(firstHosts).toEqual([`localhost:${first.port}`])
    await vi.waitFor(() => expect(first.peers.size + second.peers.size).toBe(0))
  })

  it('uses a fresh validated address on each redirect instead of retaining an old connection', async () => {
    const seen: string[] = []
    const first = await listen('127.0.0.1', (request, response) => { seen.push(`first:${request.url}`); response.end('redirected') })
    const second = await listen('127.0.0.2', (request, response) => {
      seen.push(`second:${request.url}`)
      response.writeHead(302, { location: '/final' }).end()
    }, first.port)
    const resolve = vi.fn().mockResolvedValueOnce(['127.0.0.2']).mockResolvedValueOnce(['127.0.0.1'])
    const result = await safeFetch(`http://localhost:${first.port}/start`, config, { resolve })
    expect(await result.response.text()).toBe('redirected')
    expect(seen).toEqual(['second:/start', 'first:/final'])
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(result.finalUrl.pathname).toBe('/final')
    await vi.waitFor(() => expect(first.peers.size + second.peers.size).toBe(0))
  })

  it('propagates its dispatcher through the existing fetch wrapper contract', async () => {
    const server = await listen('127.0.0.1', (_request, response) => response.end('wrapped'))
    const dispatchers: Array<{ closed: boolean; destroyed: boolean }> = []
    const result = await safeFetch(`http://fixture.invalid:${server.port}/`, config, {
      resolve: async () => ['127.0.0.1'],
      fetchImpl: (input, init) => {
        dispatchers.push((init as RequestInit & { dispatcher: typeof dispatchers[number] }).dispatcher)
        return fetch(input, { ...init })
      },
    })
    expect(await result.response.text()).toBe('wrapped')
    expect(dispatchers).toHaveLength(1)
    await vi.waitFor(() => expect(dispatchers[0]?.destroyed).toBe(true))
    expect(dispatchers[0]?.closed).toBe(true)
  })

  it('closes the actual connection after cancelling a response body', async () => {
    const server = await listen('127.0.0.1', (_request, response) => { response.writeHead(200); response.write('partial') })
    const result = await safeFetch(`http://fixture.invalid:${server.port}/`, config, { resolve: async () => ['127.0.0.1'] })
    expect(server.peers.size).toBe(1)
    await result.response.body!.cancel()
    await vi.waitFor(() => expect(server.peers.size).toBe(0))
  })

  it('aborts an in-flight connection before headers arrive', async () => {
    let received = false
    const server = await listen('127.0.0.1', () => { received = true })
    const controller = new AbortController()
    const operation = safeFetch(`http://fixture.invalid:${server.port}/`, config, { resolve: async () => ['127.0.0.1'], signal: controller.signal })
    const rejected = expect(operation).rejects.toBeDefined()
    await vi.waitFor(() => expect(received).toBe(true))
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(server.peers.size).toBe(0))
  })

  it('aborts DNS without dispatching a request, including synchronous resolver cancellation', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn()
    await expect(safeFetch('http://fixture.invalid/', config, {
      signal: controller.signal,
      resolve: () => { controller.abort(); return new Promise(() => {}) }, fetchImpl,
    })).rejects.toBeDefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('releases a HEAD connection without requiring a response body consumer', async () => {
    const server = await listen('127.0.0.1', (_request, response) => response.end('body'))
    const result = await safeFetch(`http://fixture.invalid:${server.port}/`, config, { method: 'HEAD', resolve: async () => ['127.0.0.1'] })
    expect(result.response.body).toBeNull()
    await vi.waitFor(() => expect(server.peers.size).toBe(0))
  })

  it('connects to a validated IPv6 result when the host permits IPv6 loopback', async context => {
    const server = await listen('::1', (_request, response) => response.end('ipv6'))
    const unavailable = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      const probe = connect({ host: '::1', port: server.port }, () => { probe.destroy(); resolve(null) })
      probe.once('error', resolve)
    })
    if (unavailable?.code === 'EACCES' || unavailable?.code === 'EADDRNOTAVAIL') {
      context.skip(`Host denies native IPv6 loopback: ${unavailable.code}`)
      return
    }
    if (unavailable) throw unavailable
    const result = await safeFetch(`http://fixture.invalid:${server.port}/`, config, { resolve: async () => ['::1'] })
    expect(await result.response.text()).toBe('ipv6')
    await vi.waitFor(() => expect(server.peers.size).toBe(0))
  })

  it('retains both address families and can fall back to an available validated candidate', async () => {
    const server = await listen('127.0.0.1', (_request, response) => response.end('fallback'))
    const result = await safeFetch(`http://fixture.invalid:${server.port}/`, config, { resolve: async () => ['::1', '127.0.0.1'] })
    expect(await result.response.text()).toBe('fallback')
    await vi.waitFor(() => expect(server.peers.size).toBe(0))
  })

  it('preserves the original TLS SNI while pinning DNS, without disabling certificate checks', async () => {
    const names: string[] = []
    const server = createTlsServer({ SNICallback: (name, done) => {
      names.push(name)
      done(new Error('Synthetic certificate refusal'))
    } })
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture listener has no address')
    await expect(safeFetch(`https://fixture.invalid:${address.port}/`, config, { resolve: async () => ['127.0.0.1'] })).rejects.toBeDefined()
    expect(names).toEqual(['fixture.invalid'])
  })
})
