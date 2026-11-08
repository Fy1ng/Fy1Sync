import { bilibiliImageUrl } from '../src/core/bilibiliMetadata'
import { safeFetch } from '../server/safeFetch'
import { isAppOrigin } from './security'

const cache = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: string }>()
export async function bilibiliEmoteResponse(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const target = bilibiliImageUrl(url.searchParams.get('url'))
  if (!isAppOrigin(request.url) || !target || request.method !== 'GET') return new Response(null, { status: 404 })
  try {
    let image = cache.get(target)
    if (!image) {
      const { response } = await safeFetch(target, { enabled: true, hosts: [new URL(target).hostname], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 10000 }, { signal: AbortSignal.timeout(10000), headers: { Referer: 'https://live.bilibili.com/' } })
      const type = response.headers.get('content-type')?.split(';')[0] ?? ''
      if (!response.ok || !['image/png', 'image/gif', 'image/webp', 'image/jpeg'].includes(type)) { await response.body?.cancel(); throw new Error() }
      const reader = response.body!.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw new Error(); chunks.push(value) } }
      finally { await reader.cancel().catch(() => {}) }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      image = { bytes, type }; if (cache.size >= 64) cache.delete(cache.keys().next().value!); cache.set(target, image)
    }
    return new Response(image.bytes, { headers: { 'Content-Type': image.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'max-age=3600' } })
  } catch { return new Response(null, { status: 502 }) }
}
