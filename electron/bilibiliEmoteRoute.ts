import { networkContext } from '../server/networkPolicy'
import { readPlatformBytes } from '../server/platformResponse'
import { safeFetch } from '../server/safeFetch'
import { bilibiliImageUrl } from '../src/core/bilibiliMetadata'
import { isAppOrigin } from './security'

const cache = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>()
const allowedTypes = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg'])

export async function bilibiliEmoteResponse(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = bilibiliImageUrl(url.searchParams.get('url'))
  if (!isAppOrigin(url.href) || url.pathname !== '/bilibili-emote' || !target || request.method !== 'GET') {
    return new Response(null, { status: 404 })
  }
  try {
    request.signal.throwIfAborted()
    let image = cache.get(target)
    if (!image) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
      const { response } = await safeFetch(target, {
        enabled: true, hosts: [new URL(target).hostname], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 10_000,
      }, { signal, network: networkContext('bilibili'), headers: { Referer: 'https://live.bilibili.com/' } })
      const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      if (!response.ok || !allowedTypes.has(type)) {
        await response.body?.cancel()
        return new Response(null, { status: 502 })
      }
      image = { bytes: await readPlatformBytes(response, signal), type }
      if (!image.bytes.length) return new Response(null, { status: 502 })
      if (cache.size >= 32) cache.delete(cache.keys().next().value!)
      cache.set(target, image)
    }
    return new Response(image.bytes, {
      headers: { 'Content-Type': image.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=3600' },
    })
  } catch {
    return new Response(null, { status: 502 })
  }
}
