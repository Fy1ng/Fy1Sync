export const APP_URL = 'app://app/'
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' blob:", "media-src 'self' blob: data:", "worker-src 'self' blob:",
  "img-src 'self' data: blob:", "font-src 'self'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
].join('; ')

export function isAppOrigin(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'app:' && url.hostname === 'app' && !url.port && !url.username && !url.password
  } catch { return false }
}
export function isAppDocument(raw: string): boolean {
  if (!isAppOrigin(raw)) return false
  return ['/', '/index.html', '/admin', '/admin/'].includes(new URL(raw).pathname)
}
