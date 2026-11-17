import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { DouyinHttpLogin, DouyinHttpLoginError } from './httpLogin'
import { parseDouyinSigningSnapshot } from './signingMaterial'
import { douyinBrowserCookieFingerprint } from '../../electron/cookies'
import { douyinHttpLoginFailureDetails, douyinHttpLoginFailureMessage } from './httpLoginFailure'

function png(): string {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1 }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (name: string, bytes: Buffer) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length)
    const content = Buffer.concat([Buffer.from(name), bytes]), checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(content))
    return Buffer.concat([size, content, checksum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(96, 0); header.writeUInt32BE(96, 4); header[8] = 8
  const pixels = Buffer.alloc(97 * 96, 127)
  for (let row = 0; row < 96; row++) pixels[row * 97] = 0
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

type Mode = 'waiting' | 'confirmed' | 'mismatch' | 'wrong-user' | 'guest' | 'foreign-redirect' | 'relative-redirect' | 'verification' | 'unknown-sms' | 'rejected'
const qrImage = png()
function fixture(options: { requestTimeoutMs?: number } = {}) {
  let mode: Mode = 'waiting', now = 1794400000000
  const calls: Array<{ url: URL; method: string; body: string; headers: Headers }> = []
  const controller = new AbortController()
  const peer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const resources = { peerPublicKey: vi.fn(async () => peer), timestampSeconds: vi.fn(async () => Math.floor(now / 1000)), dispose: vi.fn() }
  let pending: (() => void) | null = null, stall = false
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), headers = new Headers(init?.headers)
    calls.push({ url, headers, method: init?.method || 'GET', body: String(init?.body || '') })
    if (stall && url.pathname === '/passport/web/check_qrconnect/') await new Promise<void>(resolve => { pending = resolve })
    const json = (data: Record<string, unknown>, extraHeaders?: HeadersInit) => Response.json({ message: 'success', data }, { headers: extraHeaders })
    if (url.hostname === 'mssdk.bytedance.com') return new Response('{}', { headers: { 'x-ms-token': 't'.repeat(url.pathname === '/web/common' ? 172 : 164) } })
    if (url.pathname === '/') return new Response('<!doctype html>', { headers: { 'set-cookie': 'passport_csrf_token=synthetic; Domain=.douyin.com; Path=/; Secure' } })
    if (url.pathname === '/passport/web/get_qrcode/') return json({ error_code: 0, token: 'synthetic-qr-token', qrcode: qrImage })
    const proof = () => {
      const raw = mode === 'mismatch' ? 'invalid-synthetic-public' : headers.get('bd-ticket-guard-ree-public-key')
      return { 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({ ticket: 'synthetic-ticket', ts_sign: 'ts.2.synthetic-proof', client_cert: 'pub.' + raw })).toString('base64'),
        'set-cookie': 'sessionid=synthetic-http-session; Domain=.douyin.com; Path=/; Secure; HttpOnly' }
    }
    if (url.pathname === '/passport/web/check_qrconnect/') {
      if (mode === 'waiting') return json({ error_code: 0, status: 'new' })
      if (mode === 'verification') return json({ error_code: 2046 })
      if (mode === 'rejected') return json({ error_code: 4031 })
      return json({ error_code: 0, status: 'confirmed', ...(mode !== 'guest' ? { user_id: '12345' } : {}),
        ...(mode === 'foreign-redirect' ? { redirect_url: 'https://evil.example/?secret=synthetic' } : {}),
        ...(mode === 'relative-redirect' ? { redirect_url: '/passport/callback/' } : {}) }, proof())
    }
    if (url.pathname === '/passport/callback/') return new Response(null, { status: 302, headers: { location: 'https://www.douyin.com/complete' } })
    if (url.pathname === '/complete') return new Response('complete')
    if (url.pathname === '/passport/web/send_code/') return mode === 'unknown-sms' ? Response.json({}) : json({ error_code: 0 })
    if (url.pathname === '/passport/web/sms_login/' || url.pathname === '/passport/web/user/login/') return json({ error_code: 0, user_id: '12345' }, proof())
    if (url.pathname === '/passport/account/info/v2/') return json({ error_code: 0, user_id: '12345' })
    if (url.pathname === '/webcast/user/me/') return mode === 'guest' ? Response.json({ status_code: 20003 })
      : Response.json({ status_code: 0, data: { id_str: mode === 'wrong-user' ? '999' : '12345', nickname: 'synthetic' } })
    throw new Error('Unexpected synthetic request')
  }
  const fetchImpl = vi.fn(transport), resolve = vi.fn(async () => ['93.184.216.34'])
  const session = new DouyinHttpLogin({ signal: controller.signal, now: () => now, signingResources: resources,
    proxy: { enabled: true, hosts: [], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: options.requestTimeoutMs ?? 1000 },
    network: () => ({ route: async () => ({ kind: 'direct' }) }), fetchImpl, resolve })
  return { session, calls, controller, resources, transport: fetchImpl, resolve, mode(value: Mode) { mode = value }, advance(milliseconds: number) { now += milliseconds },
    stall() { stall = true }, pending: () => pending, release() { pending?.() } }
}

describe('pure HTTP passport login', () => {
  it('refreshes the SMS token before one credential dispatch, omits provider headers from SMS sending, and reuses its prepared token for code login', async () => {
    const f = fixture()
    try {
      await f.session.initialize()
      expect(f.calls.find(value => value.url.pathname === '/passport/web/get_qrcode/')!.headers.has('bd-ticket-guard-ree-public-key')).toBe(false)
      await f.session.sendSms({ countryCode: '+86', phone: '13800000000' })
      const common = f.calls.findIndex(value => value.url.pathname === '/web/common')
      const send = f.calls.findIndex(value => value.url.pathname === '/passport/web/send_code/')
      expect(common).toBeGreaterThan(-1)
      expect(common).toBeLessThan(send)
      expect(f.calls[common]!.headers.has('cookie')).toBe(false)
      expect(f.calls[send]!.headers.has('bd-ticket-guard-ree-public-key')).toBe(false)
      expect(f.calls[send]!.url.searchParams.get('msToken')).toBe('t'.repeat(172))
      expect(f.calls[send]!.headers.get('cookie')).toContain('msToken=' + 't'.repeat(172))
      const result = await f.session.loginSms({ countryCode: '+86', phone: '13800000000', code: '123456' })
      expect(result.status).toBe('authenticated')
      expect(f.calls.filter(value => value.url.pathname === '/web/common')).toHaveLength(1)
      expect(f.calls.find(value => value.url.pathname === '/passport/web/sms_login/')!.headers.has('bd-ticket-guard-ree-public-key')).toBe(true)
    } finally { f.session.dispose() }
  })

  it('does not dispatch or reserve an SMS write if token preparation returns only the short initial token', async () => {
    const f = fixture(), original = f.transport.getMockImplementation()!
    f.transport.mockImplementation((input, init) => new URL(String(input)).pathname === '/web/common'
      ? Promise.resolve(new Response('{}', { headers: { 'x-ms-token': 't'.repeat(164) } })) : original(input, init))
    try {
      await f.session.initialize()
      await expect(f.session.sendSms({ countryCode: '+86', phone: '13800000000' })).rejects.toMatchObject({ code: 'douyin-http-login-token-unavailable', nextAllowedAt: undefined })
      expect(f.calls.some(value => value.url.pathname === '/passport/web/send_code/')).toBe(false)
      f.transport.mockImplementation(original)
      expect((await f.session.sendSms({ countryCode: '+86', phone: '13800000000' })).status).toBe('sms-sent')
      expect(f.calls.filter(value => value.url.pathname === '/passport/web/send_code/')).toHaveLength(1)
    } finally { f.session.dispose() }
  })

  it('keeps the signed query and cookie on a token renewed by the login response', async () => {
    const f = fixture()
    try {
      await f.session.initialize()
      f.transport.mockResolvedValueOnce(Response.json({ data:{error_code:0,status:'new'} }, {headers:{'x-ms-token':'r'.repeat(172)}}))
      await f.session.poll()
      await f.session.poll()
      const poll = f.calls.find(value => value.url.pathname === '/passport/web/check_qrconnect/')!
      expect(poll.url.searchParams.get('msToken')).toBe('r'.repeat(172))
      expect(poll.headers.get('cookie')).toContain('msToken='+'r'.repeat(172))
    } finally { f.session.dispose() }
  })

  it('reinitializes through manual QR refresh after an interrupted bootstrap instead of returning an unusable login session', async () => {
    const f = fixture()
    f.transport.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed PRIVATE_INPUT'), { cause: { code: 'ECONNRESET' } }))
    try {
      await expect(f.session.initialize()).rejects.toMatchObject({ code: 'douyin-http-login-network-unavailable', requestStage: 'bootstrap', networkCode: 'connection-failed' })
      expect((await f.session.refreshQr()).image).toBe('data:image/png;base64,' + qrImage)
      expect(await f.session.sendSms({ countryCode: '+86', phone: '13800000000' })).toEqual({ status: 'sms-sent', cooldownSeconds: 60 })
      expect(f.calls.filter(value => value.url.pathname === '/passport/web/send_code/')).toHaveLength(1)
      expect(f.calls.some(value => value.url.hostname === 'mssdk.bytedance.com')).toBe(true)
    } finally { f.session.dispose() }
  })

  it('reports a DNS failure without confusing the local URL rejection status with an upstream HTTP response', async () => {
    const f = fixture()
    f.resolve.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_DNS_INPUT'), { code: 'ENOTFOUND' }))
    try {
      await expect(f.session.initialize()).rejects.toMatchObject({ code: 'douyin-http-login-network-unavailable', networkCode: 'dns-failed', requestStage: 'bootstrap', httpStatus: undefined })
      expect(f.transport).not.toHaveBeenCalled()
    } finally { f.session.dispose() }
  })

  it('distinguishes an expired request deadline from a cancelled login attempt', async () => {
    const f = fixture({ requestTimeoutMs: 25 })
    let complete!: (response: Response) => void
    f.transport.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    try {
      const pending = f.session.initialize()
      await expect(pending).rejects.toMatchObject({ code: 'douyin-http-login-timeout', requestStage: 'bootstrap' })
      expect(f.controller.signal.aborted).toBe(false)
      expect(f.calls.some(value => /send_code|sms_login|user\/login/.test(value.url.pathname))).toBe(false)
    } finally { f.session.dispose(); complete?.(new Response('late')) }
  })

  it.each([
    { response: () => new Response('PRIVATE_HTML', { status: 403 }), expected: { code: 'douyin-http-login-rejected', httpStatus: 403 }, text: 'HTTP 403' },
    { response: () => Response.json({ data: { error_code: 1101, description: 'PRIVATE_DESCRIPTION' } }), expected: { code: 'douyin-http-login-rejected', platformCode: 1101 }, text: '平台码 1101' },
    { response: () => new Response('PRIVATE_NOT_JSON'), expected: { code: 'douyin-http-login-receipt-invalid' }, text: '结果不完整' },
  ])('preserves $text on a failed credential request without labeling it a network failure or repeating it', async ({ response, expected, text }) => {
    const f = fixture()
    try {
      await f.session.initialize()
      f.transport.mockResolvedValueOnce(response())
      try { await f.session.loginPassword({ username: '13800000000', password: 'PRIVATE_PASSWORD' }); throw new Error('Expected failure') }
      catch (error) {
        expect(error).toMatchObject({ ...expected, requestStage: 'password-login' })
        expect((error as Error).message).toContain(text)
        expect((error as Error).message).not.toContain('检查网络')
        expect(JSON.stringify(error)).not.toMatch(/PRIVATE|13800000000/)
      }
      expect(f.transport.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/passport/web/user/login/')).toHaveLength(1)
    } finally { f.session.dispose() }
  })

  it('classifies invalid anonymous token receipts as session setup failures, rather than inventing a network cause', async () => {
    const f = fixture(), transport = f.transport.getMockImplementation()!
    f.transport.mockImplementation(async (input, init) => new URL(String(input)).hostname === 'mssdk.bytedance.com' ? new Response('{}') : transport(input, init))
    try {
      await expect(f.session.initialize()).rejects.toMatchObject({ code: 'douyin-http-login-token-unavailable', requestStage: 'token' })
      expect(f.calls.some(value => value.url.pathname === '/passport/web/get_qrcode/')).toBe(false)
    } finally { f.session.dispose() }
  })

  it('accepts only diagnostic data descriptors and never reads arbitrary error text or accessors', () => {
    const getter = vi.fn(() => 'PRIVATE_SECRET')
    const error = { code: 'douyin-http-login-rejected', platformCode: 4031, requestStage: 'password-login', networkCode: 'PRIVATE_SECRET', response: 'PRIVATE_RESPONSE' }
    Object.defineProperty(error, 'message', { get: getter })
    const detail = douyinHttpLoginFailureDetails(error)
    expect(detail).toEqual({ code: 'douyin-http-login-rejected', platformCode: 4031, requestStage: 'password-login' })
    expect(douyinHttpLoginFailureMessage(detail)).toContain('平台码 4031')
    expect(JSON.stringify(detail)).not.toContain('PRIVATE')
    expect(getter).not.toHaveBeenCalled()
    Object.defineProperty(error, 'code', { get: getter })
    expect(douyinHttpLoginFailureDetails(error).code).toBe('douyin-http-login-failed')
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects invalid code and password lengths before any credential request', async () => {
    const f = fixture()
    try {
      await f.session.initialize()
      await expect(f.session.loginSms({ countryCode: '+86', phone: '13800000000', code: '12345' })).rejects.toMatchObject({ code: 'douyin-http-login-input-invalid' })
      await expect(f.session.loginPassword({ username: '13800000000', password: 'x'.repeat(129) })).rejects.toMatchObject({ code: 'douyin-http-login-input-invalid' })
      expect(f.calls.some(value => value.url.pathname === '/passport/web/sms_login/' || value.url.pathname === '/passport/web/user/login/')).toBe(false)
    } finally { f.session.dispose() }
  })

  it('creates an anonymous QR and signs the exact final POST body on the login subdomain', async () => {
    const f = fixture()
    try {
      const qr = await f.session.initialize()
      expect(qr.image).toBe('data:image/png;base64,' + qrImage)
      expect(await f.session.poll()).toEqual({ status: 'waiting' })
      const poll = f.calls.find(value => value.url.pathname === '/passport/web/check_qrconnect/')!
      expect(poll.url.hostname).toBe('login.douyin.com')
      expect(poll.method).toBe('POST')
      expect(poll.body).toBe('need_logo=false&is_frontier=true&token=synthetic-qr-token&is_new_login=1&next=https%3A%2F%2Fwww.douyin.com&need_short_url=true')
      expect(poll.url.searchParams.get('a_bogus')).toBeTruthy()
      expect(poll.url.searchParams.get('passport_jssdk_version')).toBe('3.4.9')
      expect(poll.headers.get('x-tt-session-dtrait')).toMatch(/^d0_/)
      expect(f.calls.some(value => /send_code|sms_login|user\/login/.test(value.url.pathname))).toBe(false)
      expect(f.calls[0]!.headers.get('cookie')).not.toMatch(/sessionid=/)
    } finally { f.session.dispose() }
  })

  it('returns a matched main-only key/ticket record only after official live identity verification', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('confirmed')
      const result = await f.session.poll()
      expect(result.status).toBe('authenticated')
      if (result.status !== 'authenticated') throw new Error('Expected verified fixture')
      expect(result.snapshot).not.toBeNull()
      const material = parseDouyinSigningSnapshot(result.snapshot!)
      expect(material.accountUid).toBe('12345')
      expect(material.cookieFingerprint).toBe(douyinBrowserCookieFingerprint(result.cookies))
      expect(createPublicKey(material.privateKeyPem).export({ format: 'pem', type: 'spki' }).toString()).toBe(material.publicKeyPem)
      expect(f.calls.find(value => value.url.pathname === '/webcast/user/me/')?.headers.get('cookie')).toContain('bd-web-sign-page-guard=')
    } finally { f.session.dispose() }
  })

  it.each(['mismatch', 'wrong-user', 'guest'] as const)('rejects %s proof or identity instead of accepting stored cookie presence', async mode => {
    const f = fixture()
    try { await f.session.initialize(); f.mode(mode); await expect(f.session.poll()).rejects.toBeInstanceOf(DouyinHttpLoginError) }
    finally { f.session.dispose() }
  })

  it('blocks a foreign redirect before a cookie or signed request reaches it', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('foreign-redirect')
      await expect(f.session.poll()).rejects.toMatchObject({ code: 'douyin-http-login-destination-invalid' })
      expect(f.calls.every(value => value.url.hostname.endsWith('douyin.com') || value.url.hostname === 'mssdk.bytedance.com')).toBe(true)
    } finally { f.session.dispose() }
  })

  it('resolves relative locations using each verified redirect URL', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('relative-redirect')
      expect((await f.session.poll()).status).toBe('authenticated')
      expect(f.calls.some(value => value.url.href === 'https://login.douyin.com/passport/callback/')).toBe(true)
      expect(f.calls.some(value => value.url.href === 'https://www.douyin.com/complete')).toBe(true)
    } finally { f.session.dispose() }
  })

  it('preserves a challenged QR token without automatically sending any SMS', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('verification')
      expect((await f.session.poll()).status).toBe('verification-required')
      expect((await f.session.poll()).status).toBe('verification-required')
      const polls = f.calls.filter(value => value.url.pathname === '/passport/web/check_qrconnect/')
      expect(polls.map(value => new URLSearchParams(value.body).get('token'))).toEqual(['synthetic-qr-token', 'synthetic-qr-token'])
      expect(f.calls.some(value => value.url.pathname === '/passport/web/send_code/')).toBe(false)
    } finally { f.session.dispose() }
  })

  it('requires one explicit SMS action, protects unknown receipts, and never repeats a write', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('unknown-sms')
      await expect(f.session.sendSms({ countryCode: '+86', phone: '13800000000' })).rejects.toMatchObject({ code: 'douyin-http-login-receipt-invalid', nextAllowedAt: expect.any(Number) })
      await expect(f.session.sendSms({ countryCode: '+86', phone: '13800000000' })).rejects.toMatchObject({ code: 'douyin-http-sms-cooldown' })
      const writes = f.calls.filter(value => value.url.pathname === '/passport/web/send_code/')
      expect(writes).toHaveLength(1)
      expect(writes[0]!.body).not.toContain('13800000000')
    } finally { f.session.dispose() }
  })

  it('drops a late response after cancellation and does not return its credentials', async () => {
    const f = fixture()
    await f.session.initialize(); f.stall(); f.mode('confirmed')
    const pending = f.session.poll()
    const rejection = expect(pending).rejects.toMatchObject({ code: 'douyin-http-login-cancelled' })
    await vi.waitFor(() => expect(f.pending()).not.toBeNull())
    f.controller.abort(); f.session.dispose(); f.release()
    await rejection
    expect(f.resources.dispose).toHaveBeenCalledOnce()
  })

  it('keeps fixed platform diagnostics without response payloads or token values', async () => {
    const f = fixture()
    try {
      await f.session.initialize(); f.mode('rejected')
      try { await f.session.poll(); throw new Error('Expected platform rejection') }
      catch (error) { expect(error).toMatchObject({ platformCode: 4031 }); expect(JSON.stringify(error)).not.toMatch(/synthetic|PRIVATE|cookie|ticket/); expect((error as Error).message).toContain('4031') }
    } finally { f.session.dispose() }
  })
})
