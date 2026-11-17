import { diagnosticDetails } from './errorDetails'
import type { ErrorDetails } from '../src/core/errorDetails'

const MAX_ERROR_BODY_BYTES = 8_192
const ERROR_FIELDS = ['code', 'message', 'msg', 'info', 'type', 'status', 'status_code', 'status_msg', 'err_code', 'error_code', 'error', 'errors', 'detail', 'retryAfter', 'retry_after'] as const

function errorFields(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= 3) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 16).map(item => errorFields(item, depth + 1))
  const fields: Record<string, unknown> = {}
  for (const key of ERROR_FIELDS) if (Object.hasOwn(value, key)) fields[key] = errorFields((value as Record<string, unknown>)[key], depth + 1)
  return fields
}

/** Capture HTTP diagnostics only; account/session payloads and headers never enter the DTO. */
export async function httpErrorDetails(response: Response): Promise<ErrorDetails> {
  const fields: Record<string, unknown> = { status: response.status, statusText: response.statusText }
  const contentType = response.headers.get('content-type')
  if (contentType !== null) fields.contentType = contentType
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter !== null) fields.retryAfter = retryAfter
  if (response.body) {
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    const deadline = Date.now() + 2_000
    let size = 0
    try {
      for (let reads = 0; reads < 64; reads++) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const next = await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('HTTP error body read timed out')), Math.max(1, deadline - Date.now()))
        })]).finally(() => { clearTimeout(timer) })
        if (next.done) break
        const remaining = MAX_ERROR_BODY_BYTES - size
        chunks.push(next.value.subarray(0, remaining))
        size += Math.min(next.value.byteLength, remaining)
        if (size >= MAX_ERROR_BODY_BYTES) { fields.bodyTruncated = true; break }
      }
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        const raw: unknown = JSON.parse(text)
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const value = raw as Record<string, unknown>
          const diagnostic: Record<string, unknown> = {}
          for (const key of ERROR_FIELDS) if (Object.hasOwn(value, key)) diagnostic[key] = errorFields(value[key])
          if (Object.keys(diagnostic).length) fields.upstream = diagnostic
        }
      } catch {
        // Recognize public edge-error titles without retaining arbitrary account page content.
        const title = /<title\b[^>]*>\s*([^<]{1,160})\s*<\/title>/i.exec(text)?.[1]?.trim()
        if (title && /^(?:Rate Limited(?:\s*-\s*Liquipedia)?|Too Many Requests|Access Denied|Forbidden|Service Unavailable|Bad Gateway|Gateway Timeout|Just a moment\.\.\.)$/i.test(title)) fields.upstream = { title }
      }
    } catch (error) { fields.bodyReadError = diagnosticDetails(error) }
    finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  return diagnosticDetails(fields)
}
