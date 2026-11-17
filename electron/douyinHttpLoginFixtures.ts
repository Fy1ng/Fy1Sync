/** Synthetic HTTP transport for the real Electron login/controller/DPAPI chain. Offline only. */
import { nativeImage } from 'electron'

type Scenario = 'form' | 'challenge' | 'password-error' | 'account-verification'
interface Context { scenario: Scenario; authenticated: boolean; requests: number; submitted: number; smsSent: number; token: string; initialAuthenticationSeen: boolean }

function sampleImage(): string {
  const size = 96, pixels = Buffer.alloc(size * size * 4, 255)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0) {
    const offset = (y * size + x) * 4
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 32
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size }).toDataURL().replace(/^data:image\/png;base64,/, '')
}

export class DouyinHttpLoginFixtures {
  private enabled = false
  private scenario: Scenario = 'form'
  private current: Context | null = null

  enable(scenario: Scenario = 'form'): void {
    if (!['form', 'challenge', 'password-error', 'account-verification'].includes(scenario)) throw new Error('Unknown HTTP login fixture')
    this.enabled = true; this.scenario = scenario
  }
  async complete(authenticated: boolean): Promise<void> {
    if (!this.current) throw new Error('No active HTTP login fixture')
    this.current.authenticated = authenticated
  }
  state(active: boolean) {
    return { active, transport: 'http', scenario: this.current?.scenario ?? this.scenario,
      authenticated: this.current?.authenticated ?? false, requests: this.current?.requests ?? 0,
      submitted: this.current?.submitted ?? 0, smsSent: this.current?.smsSent ?? 0,
      initialAuthenticationSeen: this.current?.initialAuthenticationSeen ?? false }
  }
  transport(signal: AbortSignal): typeof fetch {
    const context: Context = { scenario: this.scenario, authenticated: false, requests: 0, submitted: 0, smsSent: 0,
      token: 'synthetic-http-qr-token', initialAuthenticationSeen: false }
    this.current = context
    const image = sampleImage()
    return async (input, init) => {
      if (!this.enabled || signal.aborted) return Response.json({ data: { error_code: 1 } }, { status: 503 })
      const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers)
      context.requests++
      const json = (data: Record<string, unknown>, responseHeaders: Record<string, string> = {}) => Response.json({ message: 'success', data }, { headers: responseHeaders })
      const proofHeaders = () => ({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'synthetic-ticket-node-local-only',
        ts_sign: 'ts.2.synthetic-server-proof', client_cert: 'pub.' + (headers.get('bd-ticket-guard-ree-public-key') || '') })).toString('base64'),
        'set-cookie': 'sessionid=synthetic-embedded-session; Domain=.douyin.com; Path=/; Secure; HttpOnly' })
      if (url.hostname === 'mssdk.bytedance.com') return new Response('{}', { headers: { 'x-ms-token': 't'.repeat(url.pathname === '/web/common' ? 172 : 164) } })
      if (url.pathname === '/' && url.hostname === 'www.douyin.com') {
        context.initialAuthenticationSeen ||= /(?:^|;\s*)sessionid(?:_ss)?=/.test(headers.get('cookie') || '')
        return new Response('<!doctype html>', { headers: { 'set-cookie': 'passport_csrf_token=synthetic-csrf; Domain=.douyin.com; Path=/; Secure' } })
      }
      if (url.pathname === '/passport/web/get_qrcode/') return json({ error_code: 0, token: context.token, qrcode: image })
      if (url.pathname === '/passport/web/check_qrconnect/') {
        if (context.authenticated) return json({ error_code: 0, status: 'confirmed', user_id: '12345' }, proofHeaders())
        if ((context.scenario === 'challenge' || context.scenario === 'account-verification') && context.submitted > 0) return json({ error_code: 2046 })
        return json({ error_code: 0, status: 'new' })
      }
      if (url.pathname === '/passport/web/send_code/') { context.smsSent++; return json({ error_code: 0 }) }
      if (url.pathname === '/passport/web/user/login/' || url.pathname === '/passport/web/sms_login/') {
        context.submitted++
        if (context.scenario === 'password-error') return json({ error_code: 1101 })
        if (context.scenario !== 'form') return json({ error_code: 2046 })
        context.authenticated = true
        return json({ error_code: 0, user_id: '12345' }, proofHeaders())
      }
      if (url.pathname === '/passport/account/info/v2/') return json({ error_code: 0, user_id: '12345' })
      if (url.pathname === '/passport/user_info/get_sec_ts/') return new Response('{}', { headers: { 'bd-ticket-guard-ts': String(Math.floor(Date.now() / 1000)) } })
      if (url.pathname === '/webcast/user/me/') {
        const cookie = headers.get('cookie') || ''
        return context.authenticated && cookie.includes('sessionid=synthetic-embedded-session') && cookie.includes('bd-web-sign-page-guard=')
          ? Response.json({ status_code: 0, data: { id_str: '12345', nickname: '离线抖音测试账号' } }) : Response.json({ status_code: 20003 })
      }
      return Response.json({ data: { error_code: 1 } }, { status: 503 })
    }
  }
}
