/**
 * Validation and form parsing for user-supplied direct live stream options
 * (optional display label and origin/stream HTTP headers such as Referer and User-Agent).
 */

export interface DirectStreamOptions {
  label?: string
  headers?: Record<string, string>
}

export interface DirectStreamDraft {
  label: string
  referer: string
  userAgent: string
  customHeaders: string
}

export const EMPTY_DIRECT_DRAFT: Readonly<DirectStreamDraft> = Object.freeze({
  label: '',
  referer: '',
  userAgent: '',
  customHeaders: '',
})

export const MAX_DIRECT_LABEL_LENGTH = 100
export const MAX_DIRECT_HEADERS_COUNT = 32
export const MAX_DIRECT_HEADERS_BYTES = 16_384

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
])
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

export function normalizeDirectLabel(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_DIRECT_LABEL_LENGTH || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

export function validateDirectHeaders(raw: unknown): Record<string, string> | null | undefined {
  if (raw === undefined) return undefined
  if (!isPlainRecord(raw)) return null
  const keys = Reflect.ownKeys(raw)
  if (keys.some(key => typeof key !== 'string')) return null
  const entries = Object.entries(raw)
  if (entries.length > MAX_DIRECT_HEADERS_COUNT) return null
  const seen = new Set<string>()
  const normalized: Record<string, string> = {}
  for (const [key, value] of entries) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor || !('value' in descriptor)) return null
    const name = key.trim()
    const lower = name.toLowerCase()
    if (!name || !HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(lower) || seen.has(lower)) return null
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return null
    const trimmedValue = value.trim()
    if (!trimmedValue) continue
    seen.add(lower)
    normalized[name] = trimmedValue
  }
  if (JSON.stringify(normalized).length > MAX_DIRECT_HEADERS_BYTES) return null
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function validateDirectOptions(raw: unknown): DirectStreamOptions | null | undefined {
  if (raw === undefined) return undefined
  if (!isPlainRecord(raw)) return null
  const keys = Reflect.ownKeys(raw)
  if (keys.some(key => key !== 'label' && key !== 'headers')) return null
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)
    if (!descriptor || !('value' in descriptor)) return null
  }
  const label = normalizeDirectLabel(raw.label)
  if (label === null) return null
  const headers = validateDirectHeaders(raw.headers)
  if (headers === null) return null
  if (!label && !headers) return undefined
  return { ...(label ? { label } : {}), ...(headers ? { headers } : {}) }
}

export function hasDirectOptions(options?: DirectStreamOptions | null): boolean {
  return Boolean(options?.label || (options?.headers && Object.keys(options.headers).length > 0))
}

export function hasDirectDraft(draft: DirectStreamDraft): boolean {
  return Boolean(draft.label.trim() || draft.referer.trim() || draft.userAgent.trim() || draft.customHeaders.trim())
}

export function parseDirectDraft(
  draft: DirectStreamDraft,
): { ok: true; options?: DirectStreamOptions } | { ok: false; message: string } {
  const label = normalizeDirectLabel(draft.label)
  if (label === null) {
    return { ok: false, message: `片源名称不能超过 ${MAX_DIRECT_LABEL_LENGTH} 个字符或包含控制字符` }
  }

  const pairs: Array<[string, string]> = []
  const referer = draft.referer.trim()
  if (referer) {
    if (/[\r\n\0]/.test(referer)) return { ok: false, message: 'Referer 格式无效' }
    pairs.push(['Referer', referer])
  }
  const userAgent = draft.userAgent.trim()
  if (userAgent) {
    if (/[\r\n\0]/.test(userAgent)) return { ok: false, message: 'User-Agent 格式无效' }
    pairs.push(['User-Agent', userAgent])
  }

  for (const rawLine of draft.customHeaders.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 1) {
      return { ok: false, message: '自定义请求头每行请使用「名称: 值」格式' }
    }
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!name || !value || !HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) {
      return { ok: false, message: '自定义请求头包含无效名称或空值' }
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      return { ok: false, message: `不支持覆盖保留请求头 ${name}` }
    }
    pairs.push([name, value])
  }

  if (pairs.length > MAX_DIRECT_HEADERS_COUNT) {
    return { ok: false, message: `自定义请求头最多支持 ${MAX_DIRECT_HEADERS_COUNT} 项` }
  }
  const seen = new Set<string>()
  const rawHeaders: Record<string, string> = {}
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, message: `请求头「${name}」重复，请合并后重试` }
    }
    seen.add(lower)
    rawHeaders[name] = value
  }

  const headers = validateDirectHeaders(rawHeaders)
  if (headers === null) {
    return { ok: false, message: '请求头总长度超出限制或格式无效' }
  }

  const options = validateDirectOptions({
    ...(label ? { label } : {}),
    ...(headers ? { headers } : {}),
  })
  if (options === null) {
    return { ok: false, message: '直链参数无效，请检查后重试' }
  }
  return { ok: true, ...(options ? { options } : {}) }
}

export function draftFromDirectOptions(options?: DirectStreamOptions | null): DirectStreamDraft {
  if (!options) return { ...EMPTY_DIRECT_DRAFT }
  let referer = ''
  let userAgent = ''
  const customLines: string[] = []
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const lower = name.toLowerCase()
    if (lower === 'referer' && !referer) referer = value
    else if (lower === 'user-agent' && !userAgent) userAgent = value
    else customLines.push(`${name}: ${value}`)
  }
  return {
    label: options.label ?? '',
    referer,
    userAgent,
    customHeaders: customLines.join('\n'),
  }
}
