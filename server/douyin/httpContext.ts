import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'

/** Keep the official login and its main-process HTTP requests on the same browser identity. */
export function douyinBrowserUserAgent(raw?: string): string {
  if (typeof raw !== 'string' || raw.length > 512 || /[\x00-\x1f\x7f]/.test(raw)) return DOUYIN_USER_AGENT
  const value = raw.replace(/\b(?:Electron|Fy1Sync|stream-syncer)\/[^\s]+\s*/gi, '')
    .replace(/\bHeadlessChrome\//g, 'Chrome/').trim()
  return /\bChrome\/\d+\.\d+\.\d+\.\d+\b/.test(value) ? value : DOUYIN_USER_AGENT
}

export function douyinBrowserVersion(userAgent: string): string {
  return /\bChrome\/(\d+\.\d+\.\d+\.\d+)\b/.exec(userAgent)?.[1]
    ?? /\bChrome\/([^\s]+)/.exec(DOUYIN_USER_AGENT)![1]!
}

/** Upstream protection diagnostics are numeric codes, never arbitrary header contents. */
export function douyinGuardDiagnostics(headers: Headers): {
  guardResultPresent?: true; guardResult?: number; guardSecurityResultPresent?: true; guardSecurityResult?: number
} {
  const result: ReturnType<typeof douyinGuardDiagnostics> = {}
  for (const [header, present, code] of [
    ['bd-ticket-guard-result', 'guardResultPresent', 'guardResult'],
    ['bd-ticket-guard-sec-result', 'guardSecurityResultPresent', 'guardSecurityResult'],
  ] as const) {
    const raw = headers.get(header)
    if (raw === null) continue
    result[present] = true
    if (/^-?\d{1,8}$/.test(raw)) result[code] = Number(raw)
  }
  return result
}
