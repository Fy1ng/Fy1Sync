/** FFmpeg reads opaque loopback capabilities; only safeFetch reaches remote media. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import type { ProxyConfig } from '../server/config'
import { MediaRegistry } from '../server/mediaProxy'
import { classifyNetworkFailure, type StreamFailure } from '../server/networkFailure'
import type { NetworkContext } from '../server/networkPolicy'
import type { Resolver } from '../server/safeFetch'

export interface MediaGatewayOptions { fetchImpl?: typeof fetch; resolve?: Resolver }
export interface GatewayInput {
  url: string
  proxyUrl: string
  readFailure: () => StreamFailure | undefined
}
interface Listener { server: Server; registry: MediaRegistry; origin: string; host: string }
const CAPABILITY = /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class MediaGateway {
  private starting?: Promise<Listener>
  private closed = false
  private readonly requests = new Set<AbortController>()
  private readonly failures = new WeakMap<NetworkContext, StreamFailure>()
  constructor(private readonly config: ProxyConfig, private readonly options: MediaGatewayOptions = {}) {}

  async register(url: string, headers: Record<string, string> | undefined, network: NetworkContext): Promise<GatewayInput> {
    if (this.closed) throw new Error('媒体转发服务已关闭.')
    const listener = await this.start()
    if (this.closed) throw new Error('媒体转发服务已关闭.')
    // Isolate diagnostics per FFmpeg input while preserving its frozen route decisions.
    const inputNetwork: NetworkContext = { route: target => network.route(target) }
    return {
      url: listener.registry.register(url, headers ? { ...headers } : undefined, inputNetwork),
      // The upstream policy belongs to the Node gateway, never FFmpeg's environment.
      proxyUrl: '',
      readFailure: () => { const failure = this.failures.get(inputNetwork); return failure ? { ...failure } : undefined },
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const request of this.requests) request.abort()
    if (!this.starting) return
    const listener = await this.starting.catch(() => undefined)
    if (!listener) return
    listener.registry.clear()
    await new Promise<void>(resolve => {
      listener.server.close(() => resolve())
      listener.server.closeAllConnections()
    })
  }

  private start(): Promise<Listener> {
    if (this.starting) return this.starting
    this.starting = new Promise<Listener>((resolve, reject) => {
      let listener: Listener
      const server = createServer((request, response) => { void this.handle(listener, request, response) })
      server.maxHeadersCount = 32
      server.headersTimeout = 10_000
      server.requestTimeout = 15_000
      server.keepAliveTimeout = 1_000
      const failed = () => { server.close(); reject(new Error('无法启动本地媒体转发服务.')) }
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', failed)
        const address = server.address()
        if (!address || typeof address === 'string') { failed(); return }
        const host = `127.0.0.1:${address.port}`
        const origin = `http://${host}`
        const registry = new MediaRegistry({
          config: this.config, ...this.options, publicOrigin: origin,
          onFailure: (failure, network) => { if (network) this.failures.set(network, { ...failure }) },
        })
        listener = { server, registry, origin, host }
        resolve(listener)
      })
    })
    return this.starting
  }

  private async handle(listener: Listener, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const stop = (status: number) => { response.writeHead(status, { 'cache-control': 'no-store' }); response.end() }
    if (this.closed) { stop(503); return }
    const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'host')
    if (hosts.length !== 1 || request.headers.host !== listener.host || !request.url || !CAPABILITY.test(request.url)) {
      stop(403); return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD'); stop(405); return
    }
    const controller = new AbortController()
    this.requests.add(controller)
    const abort = () => controller.abort()
    const close = () => { if (!response.writableFinished) abort() }
    request.once('aborted', abort)
    response.once('close', close)
    let source: Response | undefined
    try {
      const headers = new Headers()
      for (const name of ['range', 'accept', 'if-none-match']) {
        const value = request.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      source = await listener.registry.handle(new Request(`app://app${request.url}`, { method: request.method, headers, signal: controller.signal }))
      if (controller.signal.aborted) { await source.body?.cancel().catch(() => {}); return }
      response.statusCode = source.status
      source.headers.forEach((value, name) => response.setHeader(name, value))
      if (!source.body || request.method === 'HEAD') {
        await source.body?.cancel().catch(() => {})
        response.end()
      } else {
        await pipeline(Readable.fromWeb(source.body as NodeReadableStream<Uint8Array>), response, { signal: controller.signal })
      }
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent) {
        // Registry records the structured cause. Never send caught diagnostics locally.
        stop(classifyNetworkFailure(error).stage === 'http' ? 502 : 503)
      } else response.destroy()
      await source?.body?.cancel().catch(() => {})
    } finally {
      controller.abort()
      this.requests.delete(controller)
      request.removeListener('aborted', abort)
      response.removeListener('close', close)
    }
  }
}
