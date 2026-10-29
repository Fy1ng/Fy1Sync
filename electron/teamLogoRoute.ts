import { LOGO_KEY, readTeamLogo } from '../server/esports/teamLogos'
import { CONTENT_SECURITY_POLICY, isAppOrigin } from './security'

export function teamLogoResponse(request: Request, userDataDir: string, bundledLogoDir?: string): Response {
  const headers = { 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'X-Content-Type-Options': 'nosniff' }
  const url = new URL(request.url), key = url.pathname.slice('/team-logo/'.length)
  // Only our canonical content version is accepted; arbitrary queries remain invalid.
  const version = url.search ? /^\?v=([a-f0-9]{64})$/.exec(url.search)?.[1] : undefined
  if (!isAppOrigin(request.url) || !url.pathname.startsWith('/team-logo/') || !LOGO_KEY.test(key)
    || (url.search && !version) || url.hash || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404, headers })
  const logo = readTeamLogo(userDataDir, key, Date.now(), bundledLogoDir)
  if (!logo || (version && version !== logo.sha256)) return new Response(null, { status: 404, headers })
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(logo.bytes), {
    headers: { ...headers, 'Content-Type': logo.type, 'Content-Length': String(logo.bytes.length),
      'Cache-Control': version ? 'max-age=604800, immutable' : 'no-store' },
  })
}
