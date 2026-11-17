import { mediaRequestPolicy, type ProxyConfig } from './config'
import type { NetworkContext } from './networkPolicy'
import { safeFetch } from './safeFetch'
import { httpFailure, StreamFailureError } from './networkFailure'

/** Unknown suffixes need a small content probe, not a filename admission rule. */
export async function probeMediaKind(url: string, headers: Record<string, string> | undefined, config: ProxyConfig,
  network: NetworkContext, fetchImpl?: typeof fetch): Promise<'hls' | 'progressive'> {
  const { response } = await safeFetch(url, mediaRequestPolicy(config), {
    network, fetchImpl, headers: { ...headers, Range: 'bytes=0-511' },
  })
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new StreamFailureError(httpFailure(response.status)) }
  const reader = response.body?.getReader()
  if (!reader) return 'progressive'
  const prefix = new Uint8Array(512)
  let length = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  network.signal?.addEventListener('abort', abort, { once: true })
  try {
    network.signal?.throwIfAborted()
    while (length < prefix.length) {
      const chunk = await reader.read()
      network.signal?.throwIfAborted()
      if (chunk.done) break
      const bytes = chunk.value.subarray(0, prefix.length - length)
      prefix.set(bytes, length); length += bytes.length
      const text = new TextDecoder().decode(prefix.subarray(0, length)).replace(/^\uFEFF/, '').trimStart()
      if (text.startsWith('#EXTM3U')) return 'hls'
      if (text && !'#EXTM3U'.startsWith(text) && ![0xef, 0xbb].includes(prefix[length - 1]!)) return 'progressive'
    }
    return 'progressive'
  } finally { network.signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
