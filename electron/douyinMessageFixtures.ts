/** Disposable offline transports. Only the E2E bootstrap can construct this fixture. */
import { syntheticDouyinPage } from '../server/platforms/fixtures/douyinFixture'
import { syntheticDouyinFrame } from '../server/danmaku/fixtures/douyin-synthetic'
import { DOUYIN_USER_AGENT, type DouyinDanmakuRoom } from '../server/platforms/douyinDanmaku'
import type { WebSocketLike } from '../server/danmaku/types'
import { DOUYIN_SIGNING_TIME_URL } from '../server/douyin/signingResources'

export type DouyinSendFixtureScenario = 'accepted' | 'challenge' | 'unknown' | 'logged-out' | 'token-unavailable' | 'http-forbidden' | 'rate-limited' | 'saved-login'
export class DouyinMessageFixtures {
  enabled = false
  private scenario: DouyinSendFixtureScenario = 'accepted'
  private sent: Array<{ room: string; text: string; signed: boolean; ticketSigned: boolean; pageGuard: boolean }> = []
  private tokenRequests = 0
  enable(scenario: DouyinSendFixtureScenario): void {
    if (!['accepted','challenge','unknown','logged-out','token-unavailable','http-forbidden','rate-limited','saved-login'].includes(scenario)) throw new Error('Invalid Douyin send fixture')
    this.enabled = true; this.scenario = scenario; this.sent = []; this.tokenRequests = 0
  }
  get usesStoredLogin(): boolean { return this.scenario === 'saved-login' }
  header = async (_url: string): Promise<string> => !this.enabled || this.scenario === 'logged-out' ? ''
    : 'sessionid=synthetic-offline-only; UIFID=synthetic-offline-device'
  request: typeof fetch = async (input, init) => {
    if (!this.enabled) throw new Error('Douyin send fixture is disabled')
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.href===DOUYIN_SIGNING_TIME_URL && init?.method==='POST') {
      const headers=new Headers(init.headers)
      if (headers.has('cookie') || headers.has('authorization')) throw new Error('Credential leak in synthetic clock request')
      return new Response(null,{headers:{'bd-ticket-guard-ts':String(Math.floor(Date.now()/1000))}})
    }
    if (url.origin === 'https://mssdk.bytedance.com' && url.pathname === '/web/r/token' && init?.method === 'POST') {
      const headers = new Headers(init.headers)
      if (headers.has('cookie') || headers.has('authorization')) throw new Error('Credential leak in offline token bootstrap')
      this.tokenRequests++
      return new Response(null,{ status:this.scenario === 'token-unavailable' ? 503 : 200,headers:{ 'x-ms-token':'a'.repeat(164) } })
    }
    if (url.origin !== 'https://live.douyin.com' || init?.method !== 'GET') throw new Error('Unexpected offline action')
    if (new Headers(init.headers).get('x-tt-argus') !== '1') return new Response('Synthetic gateway rejection',{ status:403 })
    if (url.pathname === '/webcast/user/me/') {
      const authenticated=!this.usesStoredLogin || /(?:^|;\s*)sessionid=synthetic-embedded-session(?:;|$)/.test(new Headers(init.headers).get('cookie')??'')
      return Response.json(authenticated ? { status_code:0,data:{id_str:'12345',nickname:'离线抖音测试账号'} } : {status_code:20003})
    }
    if (url.pathname === '/100') return new Response(syntheticDouyinPage())
    if (url.pathname !== '/webcast/room/chat/' || url.searchParams.get('room_id') !== '9000000000000000001' || this.sent.length >= 16) throw new Error('Unexpected offline target')
    const text = url.searchParams.get('content') ?? ''
    const headers=new Headers(init.headers)
    const ticketSigned=!!headers.get('bd-ticket-guard-client-data') && headers.get('bd-ticket-guard-version')==='2'
    const pageGuard=/(?:^|;\s*)bd-web-sign-page-guard=/.test(headers.get('cookie')||'')
    if (this.usesStoredLogin && (!ticketSigned || !pageGuard)) throw new Error('Stored-login fixture requires the complete ticket-signing path')
    this.sent.push({ room:url.searchParams.get('room_id')!, text, signed:!!url.searchParams.get('a_bogus'),ticketSigned,pageGuard })
    if (this.scenario === 'challenge') return Response.json({ status_code:500 },{ status:403, headers:{ 'bdturing-verify':'synthetic-offline-challenge' } })
    if (this.scenario === 'http-forbidden') return new Response('Synthetic gateway rejection',{ status:403 })
    if (this.scenario === 'rate-limited') return new Response(null,{ status:429,headers:{ 'retry-after':'60' } })
    if (this.scenario === 'unknown') throw new Error('Synthetic lost response')
    return Response.json({ status_code:0, data:{ msg_id_str:'9000000000000000003', content:text } })
  }
  room(webRoom: string): DouyinDanmakuRoom {
    if (!this.enabled || webRoom !== '100') throw new Error('Unexpected offline room')
    return { webRoom, roomId:'9000000000000000001', userUniqueId:'9000000000000000002', cookie:'ttwid=synthetic-anonymous',
      userAgent:DOUYIN_USER_AGENT, cursor:'synthetic-cursor', internalExt:'synthetic-internal', pushServer:'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/', heartbeatMs:15000 }
  }
  socket(): WebSocketLike {
    const listeners = new Map<string,(event: { data?: Uint8Array }) => void>()
    let closed = false
    queueMicrotask(() => { if (!closed) { listeners.get('open')?.({}); listeners.get('message')?.({ data:syntheticDouyinFrame() }) } })
    return { send() {}, close() { closed = true; listeners.clear() }, addEventListener(type, listener) { listeners.set(type,listener) } }
  }
  snapshot() { return { scenario:this.scenario, tokenRequests:this.tokenRequests, sent:this.sent.map(value => ({ ...value })) } }
}
