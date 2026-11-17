import { types as utilTypes } from 'node:util'
import { errorDetails, ERROR_DETAIL_LIMITS, type ErrorDetails } from '../src/core/errorDetails'

/** Inspect main-process exceptions without running accessors or proxy reflection traps. */
export function diagnosticDetails(value: unknown): ErrorDetails {
  const seen = new WeakSet<object>()
  let nodes = 0
  const snapshot = (raw: unknown, depth: number): unknown => {
    if (++nodes > 256) return '[truncated]'
    if (typeof raw === 'string') return raw.slice(0, ERROR_DETAIL_LIMITS.string * 2)
      .replace(/\b((?:set-cookie|cookie|authorization|proxy-authorization)\s*=\s*)[^\r\n]*/gi, '$1[redacted]')
      .replace(/(["']?(?:[\w-]{0,128}(?:cookie|auth|session|token|password|passwd|secret|ticket|credential)[\w-]{0,128}|SESSDATA|SAPISID|SID|HSID|SSID|APISID|DedeUserID|udb_biztoken)["']?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, '$1[redacted]')
    if (!raw || typeof raw !== 'object') return raw
    if (utilTypes.isProxy(raw)) return '[proxy omitted]'
    if (seen.has(raw)) return '[circular]'
    if (depth >= ERROR_DETAIL_LIMITS.depth) return '[truncated]'
    seen.add(raw)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(raw)
      if (Array.isArray(raw)) return Array.from({ length: Math.min(Number(descriptors.length?.value) || 0, ERROR_DETAIL_LIMITS.items) }, (_, index) => {
        const field = descriptors[String(index)]
        return field && 'value' in field ? snapshot(field.value, depth + 1) : '[accessor omitted]'
      })
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      if (raw instanceof Error) result.name = raw instanceof TypeError ? 'TypeError' : raw instanceof RangeError ? 'RangeError' : raw instanceof SyntaxError ? 'SyntaxError' : 'Error'
      if (raw instanceof DOMException) {
        // Invoke only the native accessors with a verified receiver, never unknown own getters.
        result.name = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(raw) as unknown
        result.message = Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get?.call(raw) as unknown
      }
      const entries = Object.entries(descriptors)
      for (const [key, field] of entries.slice(0, ERROR_DETAIL_LIMITS.keys)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue
        if (key === 'message' && raw instanceof SyntaxError && 'value' in field && typeof field.value === 'string'
          && /^Unexpected token[\s\S]* is not valid JSON$/.test(field.value.slice(0, ERROR_DETAIL_LIMITS.string * 2))) {
          result.message = 'Unexpected token [input omitted] is not valid JSON'
          continue
        }
        if (/(?:auth|cookie|password|passwd|secret|token|api.?key|csrf|credential|session|signature|ticket|^sign$|^sid$|^sessdata$|^sapisid$|^access.?key$)/i.test(key)) result[key] = '[redacted]'
        else if (/^(?:request|response|config|options|headers|socket|connection|agent|dispatcher|env|environment|process)$/i.test(key)) result[key] = '[omitted]'
        else result[key] = 'value' in field ? snapshot(field.value, depth + 1) : '[accessor omitted]'
      }
      if (entries.length > ERROR_DETAIL_LIMITS.keys) result.truncated = true
      return result
    } catch { return '[unavailable]' }
  }
  return errorDetails(snapshot(value, 0))
}
