/** Bounded diagnostic fields for local error inspection, shared by main and renderer. */
export type ErrorDetailValue = string | number | boolean | null | ErrorDetailValue[] | { [key: string]: ErrorDetailValue }
export type ErrorDetails = { [key: string]: ErrorDetailValue }
export interface DisplayError { message: string; detail?: ErrorDetails }
export const ERROR_DETAIL_LIMITS = { depth: 5, keys: 32, items: 16, string: 4096, total: 16384 } as const

const SECRET_KEY = /(?:auth|cookie|password|passwd|secret|token|api.?key|csrf|credential|session|signature|ticket|private.?key|^sign$|^sid$|^sessdata$|^sapisid$|^hsid$|^ssid$|^apisid$|^login_info$|^sidcc$|^__secure-[13]p(?:apisid|sid(?:ts|cc)?)$|^access.?key$)/i
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
    .replace(/(["']?(?:[\w-]{0,128}(?:cookie|auth|session|token|password|passwd|secret|ticket|credential|api[_-]?key|csrf|signature|private[_-]?key)[\w-]{0,128}|SESSDATA|SAPISID|SIDCC|SID|HSID|SSID|APISID|LOGIN_INFO|__Secure-[13]P(?:APISID|SID(?:TS|CC)?)|sign)["']?\s*[:=]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi, '$1' + REDACTED)
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

/**
 * Self-explanatory user/state outcomes (A1-A15) that never need raw JSON diagnostics.
 * Technical, network, HTTP, codec, tool, update, and crash errors (B1-B11) remain inspectable.
 */
const BASIC_ERROR_CODES = new Set([
  // Stream state & input validation (A3, A6-A9)
  'not-live', 'room-not-found', 'unsupported-url', 'missing-input', 'invalid-arguments',
  'too-large', 'invalid-url', 'bad-scheme', 'login-required',
  // Explicit proxy/LAN toggles (A10, A11)
  'socks4-unsupported', 'proxy-type-unsupported', 'media-network-boundary',
  // Cancellation, busy & context transitions (A13)
  'cancelled', 'login-cancelled', 'login-busy', 'login-incomplete',
  'account-busy', 'account-changed', 'no-active-account', 'room-changed', 'busy',
  // Self-explanatory browser import & Chrome checks (A14)
  'chrome-not-found', 'browser-import-unsupported', 'browser-import-profile-missing',
  'browser-import-browser-in-use', 'browser-import-uac-cancelled', 'browser-import-cancelled',
  'browser-import-invalid-request', 'browser-import-busy', 'browser-import-preview-expired',
  'browser-import-close-failed',
  // Permission gate (A15)
  'forbidden',
])

const BASIC_RESTRICTED_REASONS = new Set([
  'cookies-invalidated', 'bot-check', 'sign-in', 'members-only',
  'age-restricted', 'geo-restricted', 'private', 'room-banned',
])

const BASIC_SOURCE_REJECTION_REASONS = new Set([
  'empty', 'not-a-url', 'unsupported-scheme', 'unsupported-page',
])

const BASIC_AUTOSYNC_KINDS = new Set([
  'no-samples', 'rejected', 'frame-match', 'not-ready', 'buffer-limit', 'cancelled', 'unauthorized',
])

function readPlainField(target: unknown, key: string): unknown {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

export function isBasicSelfExplanatoryError(raw: unknown): boolean {
  if (raw === null || raw === undefined || typeof raw === 'string') return true
  if (typeof raw !== 'object' || Array.isArray(raw)) return false

  const code = readPlainField(raw, 'code')
  const reason = readPlainField(raw, 'reason')
  const kind = readPlainField(raw, 'kind')
  const nestedDetail = readPlainField(raw, 'detail')
  const nestedCode = readPlainField(nestedDetail, 'code')
  const nestedReason = readPlainField(nestedDetail, 'reason')

  if (typeof kind === 'string' && BASIC_AUTOSYNC_KINDS.has(kind)) return true
  if (typeof reason === 'string' && BASIC_SOURCE_REJECTION_REASONS.has(reason) && readPlainField(raw, 'ok') === false) return true
  if (typeof code === 'string' && BASIC_ERROR_CODES.has(code)) return true
  if (typeof reason === 'string' && BASIC_ERROR_CODES.has(reason)) return true
  if (typeof nestedCode === 'string' && BASIC_ERROR_CODES.has(nestedCode)) return true
  if (typeof nestedReason === 'string' && BASIC_ERROR_CODES.has(nestedReason)) return true

  if (code === 'restricted' || nestedCode === 'restricted') {
    const effectiveReason = typeof reason === 'string' ? reason : typeof nestedReason === 'string' ? nestedReason : ''
    if (!effectiveReason || BASIC_RESTRICTED_REASONS.has(effectiveReason)) return true
  }
  return false
}

export function hasAdditionalErrorDetails(fields: ErrorDetails, summary?: string): boolean {
  const visible = summary === undefined || !summary.trim() ? fields.message : summary
  const normalized = typeof visible === 'string' ? redactErrorText(visible).trim() : ''
  const hintText = typeof fields.hint === 'string' ? redactErrorText(fields.hint).trim() : ''
  const matchesVisible = (text: string): boolean => {
    if (!text) return true
    if (text === normalized || text === hintText) return true
    if (normalized && hintText && normalized.includes(text) && (text === redactErrorText(String(fields.message ?? '')).trim() || text === hintText)) return true
    return false
  }
  const hasValue = (value: ErrorDetailValue, key?: string): boolean => {
    if (value === null) return false
    if (key === 'ok' && value === false) return false
    if (key === 'hint' && typeof value === 'string' && normalized.includes(redactErrorText(value).trim())) return false
    if (typeof value === 'string') {
      const text = value.trim()
      return text !== '' && !matchesVisible(text) && !DETAIL_PLACEHOLDERS.has(text)
    }
    if (Array.isArray(value)) return value.some(item => hasValue(item))
    if (typeof value === 'object') {
      return Object.entries(value).some(([childKey, entry]) => hasValue(entry, childKey))
    }
    return true
  }
  return hasValue(fields)
}

export function shouldShowErrorDetails(raw: unknown, fields: ErrorDetails = errorDetails(raw), summary?: string): boolean {
  if (isBasicSelfExplanatoryError(raw)) return false
  return hasAdditionalErrorDetails(fields, summary)
}
