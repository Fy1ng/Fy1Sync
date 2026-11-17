import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { PinnedDispatcherPool, safeFetch } from './safeFetch'
import { resolveConfig } from './config'
import type { Socket } from 'node:net'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release() })
async function fixture() {
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => {
    response.setHeader('X-Synthetic-Header', 'a'.repeat(40 * 1024))
    response.end('{"LOGGED_IN":true}')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  releases.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const config = { ...resolveConfig({}, '/tmp').proxy, hosts: ['127.0.0.1'], allowNonStandardPorts: true }
  return { url, config }
}
describe('bounded browser identity response headers', () => {
  it('keeps the default limit and permits the explicit YouTube-sized metadata response', async () => {
    const f = await fixture()
    const options = { fetchImpl: undiciFetch as unknown as typeof fetch }
    await expect(safeFetch(f.url, f.config, options)).rejects.toThrow()
    const result = await safeFetch(f.url, f.config, { ...options, maxHeaderSize: 256 * 1024 })
    expect(await result.response.text()).toBe('{"LOGGED_IN":true}')
  })
  it('separates pooled connections with different response-header limits', async () => {
    const f = await fixture()
    const pool = new PinnedDispatcherPool(); releases.push(() => pool.dispose())
    const options = { fetchImpl: undiciFetch as unknown as typeof fetch, dispatcherPool: pool }
    const result = await safeFetch(f.url, f.config, { ...options, maxHeaderSize: 256 * 1024 })
    expect(await result.response.text()).toContain('LOGGED_IN')
    await expect(safeFetch(f.url, f.config, options)).rejects.toThrow()
  })
  it.each([0, -1, Infinity, NaN, 3.5, 256 * 1024 + 1])('rejects invalid service header limit %s before requesting', async maxHeaderSize => {
    await expect(safeFetch('https://example.com/', resolveConfig({}, '/tmp').proxy, { maxHeaderSize })).rejects.toThrow('响应头大小上限无效')
  })
})
