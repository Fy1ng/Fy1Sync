import { describe, expect, it, vi } from 'vitest'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'
import { metadataConfig } from './config'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'

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
      const config = { ...metadataConfig(), hosts: ['fixture.invalid'], allowNonStandardPorts: true, allowNonLoopbackTargets: true }
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
      await (await safeFetch('https://liquipedia.net/counterstrike/api.php', metadataConfig(), options)).response.text()
      await (await safeFetch('https://liquipedia.net/counterstrike/api.php', metadataConfig(), options)).response.text()
      const dispatcher = (index: number) => (request.mock.calls[index]![1] as RequestInit & { dispatcher: unknown }).dispatcher
      expect(dispatcher(0)).toBe(dispatcher(1))
      addresses = ['93.184.216.35']
      await (await safeFetch('https://liquipedia.net/counterstrike/api.php', metadataConfig(), options)).response.text()
      expect(dispatcher(2)).not.toBe(dispatcher(1))
      addresses = ['127.0.0.1']
      await expect(safeFetch('https://liquipedia.net/counterstrike/api.php', metadataConfig(), options)).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(3)
    } finally { await pool.dispose() }
  })
  it('rejects use after disposal', async () => {
    const pool = new PinnedDispatcherPool()
    await pool.dispose()
    await expect(safeFetch('https://liquipedia.net/counterstrike/api.php', metadataConfig(), {
      dispatcherPool: pool, resolve: async () => ['93.184.216.34'], fetchImpl: async () => new Response('{}'),
    })).rejects.toThrow('Network service closed')
  })
})
