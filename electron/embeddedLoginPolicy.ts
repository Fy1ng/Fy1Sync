import type { EmbeddedLoginPlatform, EmbeddedLoginViewport } from './embeddedLoginContracts'
import { loginMediaRequest } from './loginMediaGuard'

const PRIMARY: Record<EmbeddedLoginPlatform, readonly string[]> = {
  douyin: ['live.douyin.com', 'www.douyin.com', 'sso.douyin.com', 'sso1.douyin.com', 'sso2.douyin.com'],
  douyu: ['douyu.com', 'www.douyu.com', 'passport.douyu.com', 'yuba.douyu.com'],
  bilibili: ['bilibili.com', 'www.bilibili.com', 'passport.bilibili.com', 'live.bilibili.com'],
  huya: ['huya.com', 'www.huya.com', 'aq.huya.com', 'l.huya.com', 'udblgn.huya.com', 'lgn.huya.com'],
}
const RESOURCES: Record<EmbeddedLoginPlatform, readonly string[]> = {
  douyin: ['douyin.com', 'douyinpic.com', 'douyinstatic.com'],
  douyu: ['douyu.com', 'douyucdn.cn', 'douyucdn2.cn', 'douyucdn3.cn', 'dyscdn.com', 'dycdn.cn'],
  bilibili: ['bilibili.com', 'hdslb.com', 'biliapi.com', 'biliapi.net'],
  huya: ['huya.com', 'msstatic.com'],
}
// Observed official frontend/login/verification resources; do not allow unrelated sibling hosts.
const RESOURCE_HOSTS: readonly string[] = ['lf-webcast-platform.bytetos.com', 'lf-ucenter-web.yhgfb-cn-static.com',
  'lf-rc1.yhgfb-cn-static.com', 'lf-rc2.yhgfb-cn-static.com', 'lf-cdn-tos.bytescm.com', 'lf-c-flwb.bytetos.com', 'lf-security.bytegoofy.com',
  'lf3-config.bytetcc.com']
const QR_WEBSOCKETS = ['frontier100-normal.zijieapi.com']
const SECOND_VERIFICATION_SCRIPT = '/ucenter_web/app/second_verification_web/dist/index.umd.production.js'
const VERIFICATION_API_PATHS = new Set([
  '/passport/safe/get_verify_ways/', '/passport/safe/pack_verify_ways_data/', '/passport/safe/query_decision/',
  '/passport/safe/get_auth_ticket/v1/', '/passport/safe/verify_auth_ticket/',
  '/passport/web/send_code/', '/passport/web/send_voice_code/', '/passport/web/mobile/check_code/',
  '/passport/web/validate_code/', '/passport/web/account/verify/', '/passport/web/get_qrcode/',
  '/passport/web/email/send_code/', '/passport/web/email/check_code/', '/passport/web/email/verify/',
  '/passport/mobile/can_mobile_auth_verify/', '/passport/mobile/validate_by_qrcode/',
  '/passport/upsms/verify/', '/passport/upsms/chain_mobile/verify/', '/passport/upsms/safe_mobile/verify/',
])
const CHALLENGES = ['geetest.com', 'geevisit.com', 'geetest.net', 'geetest.cn', 'geeclouddn.com', 'geeservers.com',
  'captcha.qq.com', 'captcha.gtimg.com', 'captcha.qcloud.com', 'captcha.myqcloud.com']
const belongs = (hostname: string, roots: readonly string[]) => roots.some(root => hostname === root || hostname.endsWith(`.${root}`))

/** A website must not inspect the user's local app sessions through its quick-login SDK. */
export function loginRequestAllowed(platform: EmbeddedLoginPlatform, raw: string, resourceType = 'other'): boolean {
  if (platform === 'douyin') return douyinLoginRequestAllowed(platform, raw, resourceType)
  if (!Object.hasOwn(PRIMARY, platform) || typeof raw !== 'string' || raw.length > 16_384) return false
  if (loginMediaRequest(raw, resourceType)) return false
  if (raw === 'about:blank') return resourceType === 'subFrame'
  if (raw.startsWith('data:')) return resourceType === 'image' && /^data:image\/(png|jpeg|gif|webp);/i.test(raw)
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.port) return false
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || /(^|\.)(?:local|localhost|localdomain|intranet)(?:\.|$)/i.test(url.hostname)) return false
  if (resourceType === 'mainFrame') return url.protocol === 'https:' && PRIMARY[platform].includes(url.hostname)
  // The official passport v4 wrapper lists this exact third API fallback host.
  if (platform === 'bilibili' && url.hostname === 'gcaptcha4.gsensebot.com') {
    return url.protocol === 'https:' && ['script', 'xhr', 'other'].includes(resourceType)
      && ['/load', '/verify'].includes(url.pathname)
  }
  // Bilibili's current official passport bundle configures these exact fingerprint providers.
  if (platform === 'bilibili' && ['hdaa.shuzilm.cn', 'global-h5uni.checktrustworthiness.com'].includes(url.hostname)) return true
  return belongs(url.hostname, RESOURCES[platform]) || belongs(url.hostname, CHALLENGES)
}

function douyinLoginRequestAllowed(platform: EmbeddedLoginPlatform, raw: string, resourceType = 'other'): boolean {
  if (!Object.hasOwn(PRIMARY, platform) || typeof raw !== 'string' || raw.length > 16_384) return false
  if (loginMediaRequest(raw, resourceType)) return false
  if (raw === 'about:blank') return resourceType === 'subFrame'
  if (raw.startsWith('data:')) return resourceType === 'image' && /^data:image\/(png|jpeg|gif|webp);/i.test(raw)
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.port) return false
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || /(^|\.)(?:local|localhost|localdomain|intranet)(?:\.|$)/i.test(url.hostname)) return false
  if (url.hostname === 'v.douyin.com') return false
  if (url.protocol === 'wss:') return resourceType === 'webSocket' && QR_WEBSOCKETS.includes(url.hostname)
  if (resourceType === 'mainFrame') return url.protocol === 'https:' && PRIMARY[platform].includes(url.hostname)
  // TTVerifyCenter requests this configuration before selecting its verification resources.
  if (url.hostname === 'vcs.zijieapi.com') return url.pathname === '/vc/setting' && ['xhr', 'other'].includes(resourceType)
  // The account SDK loads this only when a login response requires additional verification.
  if (url.hostname === 'auth.zijieapi.com') return url.pathname === SECOND_VERIFICATION_SCRIPT && resourceType === 'script'
  if (url.hostname === 'verify.zijieapi.com') return VERIFICATION_API_PATHS.has(url.pathname) && ['xhr', 'other'].includes(resourceType)
  return belongs(url.hostname, RESOURCES[platform]) || RESOURCE_HOSTS.includes(url.hostname)
}

export function loginViewport(value: unknown): EmbeddedLoginViewport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['id', 'rect', 'visible'].includes(key))
    || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || typeof input.visible !== 'boolean'
    || !input.rect || typeof input.rect !== 'object' || Array.isArray(input.rect)) return null
  const rect = input.rect as Record<string, unknown>
  if (Object.keys(rect).length !== 4 || !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number'
    && Number.isFinite(rect[key]) && Math.abs(rect[key] as number) <= 32_768)) return null
  if ((rect.width as number) < 0 || (rect.height as number) < 0) return null
  return { id: input.id, visible: input.visible, rect: { x: rect.x as number, y: rect.y as number,
    width: rect.width as number, height: rect.height as number } }
}

export function loginAttemptId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 1 && typeof input.id === 'string' && /^[a-f0-9-]{36}$/.test(input.id) ? input.id : null
}
