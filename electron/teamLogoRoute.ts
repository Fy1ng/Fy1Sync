import { LOGO_KEY, readTeamLogo } from '../server/esports/teamLogos'
import { CONTENT_SECURITY_POLICY, isAppOrigin } from './security'

export function teamLogoResponse(request: Request, userDataDir: string): Response {
  const headers = { 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff' }
  const url = new URL(request.url), key = url.pathname.slice('/team-logo/'.length)
  if (!isAppOrigin(request.url) || !url.pathname.startsWith('/team-logo/') || !LOGO_KEY.test(key)
    || url.search || url.hash || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404, headers })
  const logo = readTeamLogo(userDataDir, key)
  if (!logo) return new Response(null, { status: 404, headers })
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(logo.bytes), {
    headers: { ...headers, 'Content-Type': logo.type, 'Content-Length': String(logo.bytes.length), 'Cache-Control': 'max-age=604800' },
  })
}
