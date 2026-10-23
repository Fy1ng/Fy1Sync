/** Small shared bounds for main-process actions. Never expose an upstream error. */
export const MAX_RESPONSE_BYTES = 65_536
export const MAX_TIMEOUT_MS = 15_000

export const cancelled = () => new DOMException('Douyu action cancelled.', 'AbortError')
export const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Also bounds providers and requests that do not themselves observe abort. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    if (signal.aborted) {
      void operation.catch(() => {})
      reject(cancelled())
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(cancelled())
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

export function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

export async function readPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null
  const advertised = response.headers.get('content-length')
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    cancelBody(response)
    return null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw cancelled()
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) return null
      chunks.push(chunk.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return null }
  } finally {
    signal.removeEventListener('abort', abort)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
