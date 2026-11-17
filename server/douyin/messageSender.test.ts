import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { directNetwork } from '../networkPolicy'
import { syntheticDouyinPage, syntheticDouyinRoom } from '../platforms/fixtures/douyinFixture'
import { DOUYIN_USER_AGENT } from '../platforms/douyinDanmaku'
import { DouyinMessageSender, type DouyinMessageSenderDependencies } from './messageSender'
import { syntheticDouyinSigningMaterial } from './fixtures/signingFixture'
import { DouyinSigningResources, DOUYIN_SIGNING_TIME_URL } from './signingResources'
import { createHmac, createPrivateKey, diffieHellman, hkdfSync } from 'node:crypto'

const INPUT = { room:'douyin:100', text:'测试 + & 😀', expectedUid:'12345' }
const HEADER = 'sessionid=synthetic-session; msToken=synthetic-token=; UIFID=synthetic-device'
const instances: DouyinMessageSender[] = []
function setup(options: { header?: string; identity?: unknown; identityAction?: () => Promise<Response>; page?: string; result?: unknown; status?: number; responseHeaders?: Record<string,string>; action?: () => Promise<Response>; tokenStatus?:number; tokenAction?:() => Promise<Response> } = {}, overrides: Partial<DouyinMessageSenderDependencies> = {}) {
  const sent: URL[] = []
  const tokenRequests: URL[] = []
  const fetchImpl = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(raw))
    if (url.href===DOUYIN_SIGNING_TIME_URL) {
      expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).has('cookie')).toBe(false)
      return new Response(null,{headers:{'bd-ticket-guard-ts':'1794384000'}})
    }
    if (url.origin === 'https://mssdk.bytedance.com') {
      tokenRequests.push(url)
      expect(init?.method).toBe('POST')
      expect(init?.headers).not.toHaveProperty('Cookie')
      expect(init?.headers).not.toHaveProperty('Authorization')
      return options.tokenAction ? options.tokenAction() : new Response(null,{ status:options.tokenStatus ?? 200,headers:{ 'x-ms-token':'a'.repeat(164) } })
    }
    expect(url.origin).toBe('https://live.douyin.com')
    expect(init?.redirect).toBe('manual')
    if (url.pathname === '/webcast/user/me/') return options.identityAction ? options.identityAction() : Response.json(options.identity ?? { status_code:0, data:{ id_str:'12345', nickname:'测试账号' } })
    if (url.pathname === '/100') return new Response(options.page ?? syntheticDouyinPage())
    expect(url.pathname).toBe('/webcast/room/chat/')
    sent.push(url)
    return options.action ? options.action() : Response.json(options.result ?? { status_code:0, data:{ msg_id_str:'9000000000000000002', content:INPUT.text } }, { status:options.status ?? 200, headers:options.responseHeaders })
  })
  const cookieHeader = vi.fn(async (_url: string) => options.header ?? HEADER)
  const sender = new DouyinMessageSender({ proxy:resolveConfig({}).proxy, cookieHeader, syntheticProtocol:true,network:() => directNetwork, fetchImpl:fetchImpl as typeof fetch, resolve:async () => ['93.184.216.34'], now:() => 1_794_384_000_000, ...overrides })
  instances.push(sender)
  return { sender, fetchImpl, cookieHeader, sent, tokenRequests }
}
afterEach(() => { instances.splice(0).forEach(sender => sender.dispose()); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Douyin explicit HTTP sending with synthetic credentials only', () => {
  it('keeps a verified production account distinct from an unavailable send protocol and never dispatches chat', async () => {
    const f = setup({}, { syntheticProtocol:undefined })
    expect(await f.sender.state()).toMatchObject({ loggedIn:true,loginState:'authenticated',uid:INPUT.expectedUid,canSend:false,
      detail:{ code:'douyin-signing-material-missing' } })
    f.fetchImpl.mockClear(); f.cookieHeader.mockClear()
    expect(await f.sender.send(INPUT)).toMatchObject({ status:'waiting-user',nextAllowedAt:null,detail:{ code:'douyin-signing-material-missing' } })
    expect(f.fetchImpl).not.toHaveBeenCalled()
    expect(f.cookieHeader).toHaveBeenCalledOnce()
    expect(f.sent).toHaveLength(0); expect(f.tokenRequests).toHaveLength(0)
  })
  it('requires a fully injected offline transport before permitting the synthetic protocol', async () => {
    for (const overrides of [{ fetchImpl:undefined },{ resolve:undefined }]) {
      const f = setup({},overrides)
      expect(await f.sender.send(INPUT)).toMatchObject({ status:'waiting-user',detail:{ code:'douyin-signing-material-missing' } })
      expect(f.fetchImpl).not.toHaveBeenCalled()
      expect(f.cookieHeader).toHaveBeenCalledOnce()
    }
  })
  it('requests completion of stored signing authentication when an older Cookie-only identity cannot be verified', async () => {
    const f = setup({identity:{status_code:20003}}, {syntheticProtocol:undefined})
    const result = await f.sender.state()
    expect(result).toMatchObject({loggedIn:false,canSend:false,loginState:'expired',
      detail:{platformCode:20003,code:'douyin-signing-material-missing'}})
    expect(result.message).toContain('保存抖音发送认证')
    expect(f.sent).toHaveLength(0)
  })
  it('uses matched stored credentials and trusted time for PageGuard and the real local ticket-signing path', async () => {
    const material=syntheticDouyinSigningMaterial(HEADER,DOUYIN_USER_AGENT,INPUT.expectedUid)
    const f=setup({}, {syntheticProtocol:undefined,signingMaterial:async()=>material})
    expect(await f.sender.state()).toMatchObject({loggedIn:true,canSend:true,uid:INPUT.expectedUid})
    expect((await f.sender.send(INPUT)).status).toBe('accepted')
    const url=f.sent[0]!, request=f.fetchImpl.mock.calls.at(-1)![1]!, headers=new Headers(request.headers)
    expect(headers.get('bd-ticket-guard-version')).toBe('2')
    expect(headers.get('bd-ticket-guard-web-sign-type')).toBe('1')
    const payload=JSON.parse(Buffer.from(headers.get('bd-ticket-guard-client-data')!,'base64').toString())
    const pagePair=headers.get('cookie')!.split(';').map(value=>value.trim()).find(value=>value.startsWith('bd-web-sign-page-guard='))!
    const page=JSON.parse(Buffer.from(decodeURIComponent(pagePair.split('=')[1]!),'base64').toString())
    const resources=new DouyinSigningResources({proxy:resolveConfig({}).proxy,now:()=>1794384000000})
    try {
      const peer=await resources.peerPublicKey(new AbortController().signal)
      const {createPublicKey}=await import('node:crypto')
      const shared=diffieHellman({privateKey:createPrivateKey(material.privateKeyPem),publicKey:createPublicKey(peer)})
      const key=Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(0),Buffer.alloc(0),32))
      expect(payload.req_sign).toBe(createHmac('sha256',key).update(`ticket=${material.ticket}&path=${url.pathname}&timestamp=${payload.timestamp}`).digest('base64'))
      expect(page.req_sign).toBe(createHmac('sha256',key).update(`ticket=${material.ticket}&domain=live.douyin.com&timestamp=${page.timestamp}`).digest('base64'))
    } finally { resources.dispose() }
    expect(payload.t_trust).toBe(1)
    expect(f.sent).toHaveLength(1)
    expect(f.fetchImpl.mock.calls.filter(([raw])=>String(raw)===DOUYIN_SIGNING_TIME_URL)).toHaveLength(1)
  })
  it('rejects a stored key for another credential fingerprint or account before dispatch', async () => {
    for (const material of [syntheticDouyinSigningMaterial('sessionid=other-account'),syntheticDouyinSigningMaterial(HEADER,DOUYIN_USER_AGENT,'99999')]) {
      const f=setup({}, {syntheticProtocol:undefined,signingMaterial:async()=>material})
      expect((await f.sender.send(INPUT)).status).toBe('failed')
      expect(f.sent).toHaveLength(0); expect(f.fetchImpl).not.toHaveBeenCalled()
    }
  })
  it('does not dispatch or start message cooldown when trusted signing time is unavailable', async () => {
    const material=syntheticDouyinSigningMaterial(HEADER)
    const resources={peerPublicKey:async()=>material.publicKeyPem,timestampSeconds:async()=>{throw Object.assign(new Error('Clock unavailable'),{code:'douyin-signing-resource-unavailable'})},invalidate(){},dispose(){}}
    const f=setup({}, {syntheticProtocol:undefined,signingMaterial:async()=>material,signingResources:resources})
    expect(await f.sender.send(INPUT)).toMatchObject({status:'failed',nextAllowedAt:null,detail:{code:'douyin-signing-resource-unavailable'}})
    expect(f.sent).toHaveLength(0); expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('coalesces concurrent account reads, isolates caller cancellation and returns independent cached snapshots', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = setup({ identityAction: async () => { await gate; return Response.json({ status_code:0, data:{ id_str:'12345' } }) } })
    const controller = new AbortController()
    const cancelled = f.sender.state(controller.signal)
    const reads = Array.from({ length:8 }, () => f.sender.state())
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce())
    controller.abort()
    expect(await cancelled).toMatchObject({ loginState:'unavailable', canSend:false })
    release()
    const values = await Promise.all(reads)
    expect(values.every(value => value.loginState === 'authenticated')).toBe(true)
    values[0]!.uid = '99999'
    expect(await f.sender.state()).toMatchObject({ uid:'12345', canSend:true })
    expect(f.fetchImpl).toHaveBeenCalledOnce()
    expect(f.sent).toHaveLength(0)
  })
  it('expires the short identity cache and bypasses it for an explicit refresh or account transition', async () => {
    let now = 1_794_384_000_000
    const f = setup({}, { now:() => now })
    await f.sender.state(); await f.sender.state()
    expect(f.fetchImpl).toHaveBeenCalledOnce()
    await f.sender.state(undefined,true)
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    now += 15_000
    await f.sender.state()
    expect(f.fetchImpl).toHaveBeenCalledTimes(3)
    f.cookieHeader.mockResolvedValue('sessionid=synthetic-replacement')
    await f.sender.state()
    expect(f.fetchImpl).toHaveBeenCalledTimes(4)
    f.sender.invalidate()
    await f.sender.state()
    expect(f.fetchImpl).toHaveBeenCalledTimes(5)
  })
  it('always rechecks identity before a send and drops a cached identity after an explicit anonymous reply', async () => {
    let signedIn = true
    const f = setup({ identityAction:async () => Response.json(signedIn
      ? { status_code:0,data:{ id_str:INPUT.expectedUid } } : { status_code:20003 }) })
    expect(await f.sender.state()).toMatchObject({ canSend:true })
    signedIn = false
    const outcome = await f.sender.send(INPUT)
    expect(outcome).toMatchObject({ status:'waiting-user',detail:{ platformCode:20003 } })
    expect(f.sent).toHaveLength(0)
    expect(await f.sender.state()).toMatchObject({ loginState:'expired',canSend:false })
    expect(f.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('does not restore an older authenticated cache after a failed forced check, and bounds automatic failure reads', async () => {
    let available = true, now = 1_794_384_000_000
    const f = setup({ identityAction:async () => available
      ? Response.json({ status_code:0,data:{ id_str:INPUT.expectedUid } }) : new Response(null,{status:503}) }, { now:() => now })
    expect(await f.sender.state()).toMatchObject({ canSend:true })
    available = false
    expect(await f.sender.state(undefined,true)).toMatchObject({ loginState:'unavailable',canSend:false })
    expect(await f.sender.state()).toMatchObject({ loginState:'unavailable',canSend:false })
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    available = true; now += 2_500
    expect(await f.sender.state()).toMatchObject({ loginState:'authenticated',canSend:true })
    expect(f.fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('uses the login browser identity for identity, room, token, query and signature requests', async () => {
    const userAgent = DOUYIN_USER_AGENT.replace('131.0.0.0','152.0.0.0')
    const f = setup({ header:'sessionid=synthetic-session' }, { userAgent })
    expect((await f.sender.send(INPUT)).status).toBe('accepted')
    expect(f.fetchImpl.mock.calls.every(([,init]) => new Headers(init?.headers).get('user-agent') === userAgent)).toBe(true)
    expect(f.sent[0]!.searchParams.get('browser_version')).toBe('152.0.0.0')
    expect(f.tokenRequests).toHaveLength(1)
  })
  it('preserves redacted original login-check errors without inspecting real account storage', async () => {
    const f = setup({}, { cookieHeader: async () => { throw Object.assign(new Error('storage failed Cookie=LOGIN_SECRET'), { code: 'EACCES' }) } })
    const state = await f.sender.state()
    expect(state).toMatchObject({ loginState: 'unavailable', canSend: false, detail: { code: 'EACCES' } })
    expect(JSON.stringify(state)).not.toContain('LOGIN_SECRET')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('retains original HTTP rate-limit fields without exposing response credentials or retrying', async () => {
    const f = setup({ status: 429, responseHeaders: { 'retry-after': '60' }, result: {
      status_code: 429, status_msg: 'Rate limit exceeded token=RESPONSE_SECRET', authentication: 'AUTH_SECRET',
    } })
    const result = await f.sender.send(INPUT)
    expect(result).toMatchObject({ status: 'waiting-user', detail: { status: 429, retryAfter: '60',
      upstream: { status_code: 429 } } })
    expect(JSON.stringify(result)).not.toMatch(/RESPONSE_SECRET|AUTH_SECRET|synthetic-session|synthetic-token/)
    expect(f.sent).toHaveLength(1)
  })
  it('distinguishes expired authentication from an unverifiable identity without dispatching chat',async()=>{
    const expired=setup({identity:{status_code:20003}})
    expect(await expired.sender.state()).toMatchObject({loggedIn:false,canSend:false,loginState:'expired'})
    const unknown=setup({identity:{status_code:0,data:{unexpected:true}}})
    const result=await unknown.sender.state()
    expect(result).toMatchObject({loggedIn:false,canSend:false,loginState:'unavailable'})
    expect(result.message).not.toContain('重新登录')
    expect(expired.sent).toHaveLength(0);expect(unknown.sent).toHaveLength(0)
  })
  it('does not inspect saved credentials or send while reauthentication is in progress',async()=>{
    const f=setup({}, {isLoginBusy:()=>true})
    expect(await f.sender.state()).toMatchObject({loginState:'authenticating',canSend:false})
    expect((await f.sender.send(INPUT)).message).toContain('正在重新登录')
    expect(f.cookieHeader).not.toHaveBeenCalled();expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('checks identity and internal room, then signs exactly one correctly encoded ordinary message', async () => {
    const f = setup()
    expect(await f.sender.state()).toMatchObject({ loggedIn:true, canSend:true, uid:INPUT.expectedUid, nickname:'测试账号' })
    const result = await f.sender.send(INPUT)
    expect(result).toMatchObject({ status:'accepted', messageId:'9000000000000000002' })
    expect(result.message).toContain('尚未确认房间内显示')
    expect(f.sent).toHaveLength(1)
    const url = f.sent[0]!
    expect(url.searchParams.get('room_id')).toBe('9000000000000000001')
    expect(url.searchParams.get('content')).toBe(INPUT.text)
    expect(url.searchParams.get('type')).toBe('0')
    expect(url.searchParams.get('msToken')).toBe('synthetic-token=')
    const [raw, init] = f.fetchImpl.mock.calls.at(-1)!
    expect(init?.headers).toMatchObject({ Cookie:HEADER, 'User-Agent':DOUYIN_USER_AGENT, Referer:'https://live.douyin.com/100', uifid:'synthetic-device',
      'x-tt-argus':'1',Origin:'https://live.douyin.com','Content-Type':'application/json' })
    expect(String(raw)).toContain('content=%E6%B5%8B%E8%AF%95+%2B+%26+%F0%9F%98%80')
    expect(url.searchParams.get('a_bogus')).toBeTruthy()
    expect(JSON.stringify(result)).not.toMatch(/synthetic-session|synthetic-token|a_bogus/)
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    expect(f.sent).toHaveLength(1)
  })
  it.each(['', ' ', 'x'.repeat(51), 'test\nline', '\ud800', 'a\x00b'])('does not perform any request for invalid text %s', async text => {
    const f = setup()
    expect((await f.sender.send({ ...INPUT, text })).status).toBe('failed')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['100','huya:100','douyin:0','douyin:18446744073709551616','douyin:100/../101'])('rejects invalid target %s without network', async room => {
    const f = setup()
    expect((await f.sender.send({ ...INPUT, room })).status).toBe('failed')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it.each(['', 'msToken=synthetic-token', 'sessionid=x; sessionid=y; msToken=z', 'sessionid=x\r\nInjected:1'])('does not send with absent or malformed credentials', async header => {
    const f = setup({ header })
    expect((await f.sender.send(INPUT)).status).not.toBe('accepted')
    expect(f.sent).toHaveLength(0)
  })
  it('keeps a verified account usable without an msToken cookie and prepares the token only on manual send', async () => {
    const f = setup({ header:'sessionid=synthetic-session' })
    expect(await f.sender.state()).toMatchObject({ loggedIn:true,canSend:true,uid:INPUT.expectedUid })
    expect(f.tokenRequests).toHaveLength(0)
    expect((await f.sender.send(INPUT)).status).toBe('accepted')
    expect(f.tokenRequests).toHaveLength(1)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.searchParams.get('msToken')).toBe('a'.repeat(164))
    expect(f.fetchImpl.mock.calls.at(-1)![1]?.headers).toMatchObject({ Cookie:'sessionid=synthetic-session' })
  })
  it('reports a preparation failure without asking a logged-in account to log in again or sending chat', async () => {
    const f = setup({ header:'sessionid=synthetic-session',tokenStatus:503 })
    const result = await f.sender.send(INPUT)
    expect(result).toMatchObject({ status:'failed',nextAllowedAt:null })
    expect(result.message).toContain('发送准备失败')
    expect(result.message).not.toContain('重新登录')
    expect(f.tokenRequests).toHaveLength(1)
    expect(f.sent).toHaveLength(0)
  })
  it('rechecks account and room context after token preparation before dispatching chat', async () => {
    const f = setup({ header:'sessionid=synthetic-session',tokenAction:async () => {
      f.cookieHeader.mockResolvedValue('sessionid=changed-account')
      return new Response(null,{ headers:{ 'x-ms-token':'a'.repeat(164) } })
    } })
    expect((await f.sender.send(INPUT)).status).toBe('failed')
    expect(f.sent).toHaveLength(0)
    let current = true
    const g = setup({ header:'sessionid=synthetic-session',tokenAction:async () => {
      current = false
      return new Response(null,{ headers:{ 'x-ms-token':'a'.repeat(164) } })
    } })
    expect((await g.sender.send(INPUT,undefined,() => current)).status).toBe('failed')
    expect(g.sent).toHaveLength(0)
  })
  it.each([{ status_code:20003 }, { status_code:0, data:{ id_str:'9999' } }, { status_code:0, data:{ id:12345 } }])('requires an exact authenticated public identity', async identity => {
    const f = setup({ identity })
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    expect(f.sent).toHaveLength(0)
  })
  it('rejects an ended room, a different web room and a cookie change during preflight', async () => {
    for (const page of [syntheticDouyinPage({ ...syntheticDouyinRoom(), status:4 }), syntheticDouyinPage(undefined, '200'), '<html>No verified room</html>']) {
      const f = setup({ page }); expect((await f.sender.send(INPUT)).status).not.toBe('accepted'); expect(f.sent).toHaveLength(0)
    }
    const f = setup()
    f.cookieHeader.mockImplementation(async url => url.includes('/webcast/room/chat/') ? HEADER.replace('synthetic-session','changed-session') : HEADER)
    expect((await f.sender.send(INPUT)).status).toBe('failed')
    expect(f.sent).toHaveLength(0)
  })
  it('cancels on window context changes or account invalidation before dispatch', async () => {
    const f = setup(); let current = true
    f.cookieHeader.mockImplementation(async () => { current = false; return HEADER })
    expect((await f.sender.send(INPUT, undefined, () => current)).status).toBe('failed')
    expect(f.sent).toHaveLength(0)
    const g = setup()
    g.cookieHeader.mockImplementation(async () => { g.sender.invalidate(); return HEADER })
    expect((await g.sender.send(INPUT)).status).toBe('failed')
    expect(g.sent).toHaveLength(0)
  })
  it.each([{}, { status_code:0 }, { status_code:0, data:{ msg_id:9000000000000000002, content:INPUT.text } }, { status_code:0, data:{ msg_id_str:'9000000000000000002', content:'different' } },
    { status_code:0,data:{ msg_id_str:'9000000000000000002',content:INPUT.text,user:{ id_str:'different-user' } } },
    { status_code:0,data:{ msg_id_str:'9000000000000000002',content:INPUT.text,room_id_str:'different-room' } }])('never treats a malformed or ambiguous receipt as success', async result => {
    const f = setup({ result })
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    expect(f.sent).toHaveLength(1)
  })
  it.each([20003,50001,50004,50008,40001,999999])('handles platform refusal %i without echoing sensitive details', async status_code => {
    const f = setup({ result:{ status_code, data:{ prompts:'secret-session-and-upstream-text' } } })
    const result = await f.sender.send(INPUT)
    expect(result.status).toBe('waiting-user'); expect(JSON.stringify(result)).not.toContain('secret-session')
    expect(f.sent).toHaveLength(1)
  })
  it.each([{ status:403 }, { status:429 }, { responseHeaders:{ 'bdturing-verify':'secret-challenge' } }, { result:{ status_code:0, data:{ shark_decision_conf:'secret-challenge' } } }])('does not solve or retry platform challenges', async options => {
    const f = setup(options)
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    expect(f.sent).toHaveLength(1)
  })
  it('distinguishes a bare HTTP 403 from an explicit verification instruction', async () => {
    const f = setup({ status:403,result:{ message:'sensitive-upstream-value' } })
    const rejected = await f.sender.send(INPUT)
    expect(rejected.diagnostic).toEqual({ reason:'http-rejected',httpStatus:403 })
    expect(rejected.message).toContain('未返回明确的安全验证指令')
    expect(JSON.stringify(rejected)).not.toContain('sensitive-upstream-value')
    const empty = setup({ status:403,responseHeaders:{ 'bdturing-verify':'' } })
    expect((await empty.sender.send(INPUT)).diagnostic?.reason).toBe('http-rejected')
    const g = setup({ status:403,responseHeaders:{ 'x-tt-verify-passport-decision':'secret-challenge' } })
    expect((await g.sender.send(INPUT)).diagnostic).toEqual({ reason:'verification-required',httpStatus:403 })
  })
  it('retains bounded protection result codes without exposing arbitrary security headers', async () => {
    const f = setup({ status:403, responseHeaders:{ 'bd-ticket-guard-result':'6', 'bd-ticket-guard-sec-result':'synthetic-private-data' } })
    const result = await f.sender.send(INPUT)
    expect(result).toMatchObject({ diagnostic:{ reason:'http-rejected',guardResultPresent:true,guardResult:6,guardSecurityResultPresent:true },
      detail:{ guardResult:6,guardSecurityResultPresent:true } })
    expect(result.diagnostic).not.toHaveProperty('guardSecurityResult')
    expect(JSON.stringify(result)).not.toContain('synthetic-private-data')
    expect(f.sent).toHaveLength(1)
  })
  it('honors a bounded server cooldown for HTTP 429 without presenting it as a captcha', async () => {
    const f = setup({ status:429,responseHeaders:{ 'retry-after':'60' } })
    const result = await f.sender.send(INPUT)
    expect(result.diagnostic).toEqual({ reason:'rate-limited',httpStatus:429 })
    expect(result.nextAllowedAt).toBe(1_794_384_060_000)
    expect(result.message).toContain('请求频率')
    expect(result.message).not.toContain('验证指令')
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    expect(f.sent).toHaveLength(1)
  })
  it('preserves an explicit platform refusal even if it arrives with HTTP 403', async () => {
    const f = setup({ status:403,result:{ status_code:50001,data:{ prompts:'sensitive-upstream-value' } } })
    const result = await f.sender.send(INPUT)
    expect(result.diagnostic).toEqual({ reason:'platform-rejected',httpStatus:403,platformCode:50001 })
    expect(result.message).toContain('禁言')
    expect(JSON.stringify(result)).not.toContain('sensitive-upstream-value')
  })
  it('does not follow redirects or retry a write whose response was lost', async () => {
    const f = setup({ action:async () => new Response(null,{ status:302, headers:{ location:'https://live.douyin.com/webcast/room/chat/?content=redirected' } }) })
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user'); expect(f.sent).toHaveLength(1)
    const g = setup({ action:async () => { throw new Error('Synthetic response lost with private URL') } })
    const result = await g.sender.send(INPUT)
    expect(result.status).toBe('waiting-user'); expect(result.message).not.toContain('private'); expect(g.sent).toHaveLength(1)
  })
  it('bounds concurrent sends and aborts a hung transport without resending', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const f = setup({ action:async () => { started(); return new Promise(() => {}) } })
    const controller = new AbortController(), first = f.sender.send(INPUT,controller.signal)
    await ready
    expect((await f.sender.send(INPUT)).status).toBe('waiting-user')
    controller.abort()
    // The default safe transport observes abort. This fixture ignores it deliberately.
    await expect(Promise.race([first, new Promise(resolve => setTimeout(() => resolve('hung'),100))])).resolves.not.toBe('hung')
    expect(f.sent).toHaveLength(1)
  })
  it('honors API host and DNS policy, and releases expired cooldown without a background send', async () => {
    for (const overrides of [{ proxy:{ ...resolveConfig({}).proxy,hosts:['other.invalid'] } },{ resolve:async () => [] }]) {
      const f = setup({},overrides)
      expect((await f.sender.send(INPUT)).status).toBe('failed')
      expect(f.fetchImpl).not.toHaveBeenCalled()
    }
    let now = 1_794_384_000_000
    const f = setup({}, { now:() => now })
    expect((await f.sender.send(INPUT)).status).toBe('accepted')
    now += 5000
    expect(f.sent).toHaveLength(1)
    expect((await f.sender.send(INPUT)).status).toBe('accepted')
    expect(f.sent).toHaveLength(2)
  })
})
