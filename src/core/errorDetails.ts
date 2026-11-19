/** Bounded diagnostic fields for local error inspection, shared by main and renderer. */
export type ErrorDetailValue = string | number | boolean | null | ErrorDetailValue[] | { [key: string]: ErrorDetailValue }
export type ErrorDetails = { [key: string]: ErrorDetailValue }
export interface DisplayError { message: string; detail?: ErrorDetails }
export const ERROR_DETAIL_LIMITS = { depth: 5, keys: 32, items: 16, string: 4096, total: 16384 } as const

const SECRET_KEY = /(?:auth|cookie|password|passwd|secret|token|api.?key|csrf|credential|session|signature|ticket|private.?key|^sign$|^sid$|^sessdata$|^sapisid$|^hsid$|^ssid$|^apisid$|^access.?key$)/i
const OMIT_KEY = /^(?:request|response|config|options|headers|socket|connection|agent|dispatcher|env|environment|process)$/i
const REDACTED = '[redacted]'

/** Keep the host and path useful while removing credentials and every query/fragment value. */
export function redactErrorText(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, raw => {
      try {
        const url = new URL(raw)
        if (url.username || url.password) { url.username = ''; url.password = '' }
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, REDACTED)
        if (url.hash) url.hash = REDACTED
        return url.href
      } catch { return '[invalid URL]' }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 ' + REDACTED)
    .replace(/\b(?:set-cookie|cookie|authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi, match => match.slice(0, match.search(/[:=]/) + 1) + ' ' + REDACTED)
    .replace(/(["']?(?:[\w-]{0,128}(?:cookie|auth|session|token|password|passwd|secret|ticket|credential|api[_-]?key|csrf|signature|private[_-]?key)[\w-]{0,128}|SESSDATA|SAPISID|SID|HSID|SSID|APISID|sign)["']?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, '$1' + REDACTED)
    .replace(/Unexpected token[^\r\n]* is not valid JSON/g, 'Unexpected token [input omitted] is not valid JSON')
    .replace(/\b[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '[user]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g, '[user]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
}

/** Read data descriptors only: diagnostic inspection must never invoke an error's getters. */
export function errorDetails(value: unknown): ErrorDetails {
  const seen = new WeakSet<object>()
  let remaining = ERROR_DETAIL_LIMITS.total as number
  let nodes = 0
  const text = (value: string): string => {
    const clean = redactErrorText(value.slice(0, ERROR_DETAIL_LIMITS.string * 2))
    const length = Math.min(ERROR_DETAIL_LIMITS.string, Math.max(0, remaining))
    remaining -= Math.min(clean.length, length)
    return clean.length > length ? clean.slice(0, Math.max(0, length - 14)) + ' [truncated]' : clean
  }
  const visit = (raw: unknown, depth: number): ErrorDetailValue => {
    if (++nodes > 256) return '[truncated]'
    if (raw === null || raw === undefined) return null
    if (typeof raw === 'string') return text(raw)
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : String(raw)
    if (typeof raw === 'bigint') return text(String(raw))
    if (typeof raw !== 'object') return '[unavailable]'
    if (seen.has(raw)) return '[circular]'
    if (depth >= ERROR_DETAIL_LIMITS.depth || remaining <= 0) return '[truncated]'
    seen.add(raw)
    try {
      const fields = Object.getOwnPropertyDescriptors(raw)
      if (Array.isArray(raw)) {
        const result: ErrorDetailValue[] = []
        const length = typeof fields.length?.value === 'number' ? fields.length.value : 0
        for (let index = 0; index < Math.min(length, ERROR_DETAIL_LIMITS.items); index++) {
          if (nodes >= 256 || remaining <= 0) { result.push('[truncated]'); break }
          const field = fields[String(index)]
          result.push(field && 'value' in field ? visit(field.value, depth + 1) : '[unavailable]')
        }
        if (length > ERROR_DETAIL_LIMITS.items) result.push('[truncated]')
        return result
      }
      const result: ErrorDetails = Object.create(null) as ErrorDetails
      if (raw instanceof Error) result.name = text(typeof fields.name?.value === 'string' ? fields.name.value : raw instanceof TypeError ? 'TypeError' : raw instanceof RangeError ? 'RangeError' : raw instanceof SyntaxError ? 'SyntaxError' : 'Error')
      if (typeof DOMException !== 'undefined' && raw instanceof DOMException) {
        result.name = text(String(Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(raw) ?? 'DOMException'))
        result.message = text(String(Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get?.call(raw) ?? ''))
      }
      const entries = Object.entries(fields).filter(([key]) => !['__proto__', 'prototype', 'constructor'].includes(key))
      for (const [key, field] of entries.slice(0, ERROR_DETAIL_LIMITS.keys)) {
        if (nodes >= 256 || remaining <= 0) { result.truncated = true; break }
        if (SECRET_KEY.test(key)) { result[text(key)] = REDACTED; continue }
        // These objects may contain entire account sessions. Capture explicit error fields instead.
        if (OMIT_KEY.test(key)) { result[text(key)] = '[omitted]'; continue }
        result[text(key)] = 'value' in field ? visit(field.value, depth + 1) : '[accessor omitted]'
      }
      if (entries.length > ERROR_DETAIL_LIMITS.keys) result.truncated = true
      return result
    } catch { return '[unavailable]' }
  }
  const result = visit(value, 0)
  return result && typeof result === 'object' && !Array.isArray(result) ? result : { message: result ?? '未提供原始错误信息' }
}

/** Public summaries and original fields travel together, without a message-keyed global cache. */
export function displayError(value: unknown, summary?: string): DisplayError {
  const detail = errorDetails(value)
  return { message: summary ?? (typeof detail.message === 'string' ? detail.message : '操作未完成'), detail }
}

export function errorMessage(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'string') return value
  return displayError(value).message
}

const DETAIL_PLACEHOLDERS = new Set([REDACTED, '[omitted]', '[accessor omitted]', '[unavailable]', '[circular]', '[truncated]', '未提供原始错误信息'])

export function hasAdditionalErrorDetails(fields: ErrorDetails, summary?: string): boolean {
  const visible = summary === undefined || !summary.trim() ? fields.message : summary
  const normalized = typeof visible === 'string' ? redactErrorText(visible).trim() : ''
  const hasValue = (value: ErrorDetailValue): boolean => {
    if (value === null) return false
    if (typeof value === 'string') {
      const text = value.trim()
      return text !== '' && text !== normalized && !DETAIL_PLACEHOLDERS.has(text)
    }
    if (Array.isArray(value)) return value.some(hasValue)
    if (typeof value === 'object') {
      return Object.entries(value).some(([key, entry]) => !(key === 'ok' && entry === false) && hasValue(entry))
    }
    return true
  }
  return hasValue(fields)
}
