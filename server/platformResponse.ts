/** Bounded metadata reads; media segments use their separate streaming path. */
export const MAX_PLATFORM_RESPONSE_BYTES = 2 * 1_048_576
const MAX_CHUNKS = 16_384
const cancelled = () => new DOMException('Platform response cancelled.', 'AbortError')
const invalid = () => new Error('Platform response could not be read safely.')

export async function readPlatformText(response: Response, signal: AbortSignal): Promise<string> {
  const cancelBody = () => { void response.body?.cancel().catch(() => {}) }
  if (signal.aborted) { cancelBody(); throw cancelled() }
  const advertised = response.headers.get('content-length')
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_PLATFORM_RESPONSE_BYTES)) {
    cancelBody()
    throw invalid()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw cancelled()
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { abort(); return }
        reader.read().then(value => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(cancelled())
          else resolve(value)
        }, error => { signal.removeEventListener('abort', abort); reject(error) })
      })
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_PLATFORM_RESPONSE_BYTES || chunks.length >= MAX_CHUNKS) throw invalid()
      chunks.push(chunk.value)
    }
    if (signal.aborted) throw cancelled()
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }
    catch { throw invalid() }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}
