import { createPublicKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { directNetwork } from '../networkPolicy'
import { DOUYIN_SIGNING_PEER_SOURCE, DOUYIN_SIGNING_TIME_TTL_MS, DOUYIN_SIGNING_TIME_URL,
  DouyinSigningResourceError, DouyinSigningResources } from './signingResources'

const seconds = 1_794_400_000, wall = seconds * 1000
const signal = () => new AbortController().signal
const response = (timestamp = String(seconds)) => new Response(null,{headers:{'bd-ticket-guard-ts':timestamp}})
function setup() {
  let now = wall, monotonic = 1000
  const request = vi.fn(async (_input: unknown,_init?: RequestInit) => response())
  const deps = { proxy:resolveConfig({}).proxy,network:() => directNetwork,resolve:async () => ['93.184.216.34'],
    fetchImpl:request as typeof fetch,now:() => now,monotonic:() => monotonic }
  const service = new DouyinSigningResources(deps)
  return { service,request,deps,setNow:(value:number) => {now=value},setMonotonic:(value:number) => {monotonic=value},
    advance:(ms:number) => {now+=ms;monotonic+=ms} }
}
function deferred<T>() {
  let resolve!: (value:T) => void
  const promise = new Promise<T>(done => {resolve=done})
  return {promise,resolve}
}

describe('Douyin anonymous signing resources', () => {
  it('loads the pinned official peer locally with no HTTP request or key registration', async () => {
    const f=setup(), peer=await f.service.peerPublicKey(signal())
    const key=createPublicKey(peer)
    expect(key.asymmetricKeyType).toBe('ec');expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1')
    expect(peer).toBe('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhNpZQz5X3PEavuSeR14YOHnRYz5w\nhd1GuyQaIhP36D/Zuy+RCyHL8QoBMWkQh20PJAgivwK2eBV/6gqG2QJE6A==\n-----END PUBLIC KEY-----\n')
    expect(DOUYIN_SIGNING_PEER_SOURCE.sn).toBe('533240336124694022040808462028007165443034493949')
    expect(await f.service.peerPublicKey(signal())).toBe(peer)
    expect(f.request).not.toHaveBeenCalled()
  })
  it('reads the exact SDK empty POST response header anonymously without credentials', async () => {
    const f=setup()
    expect(await f.service.timestampSeconds(signal())).toBe(seconds)
    const [url,init]=f.request.mock.calls[0]!
    expect(String(url)).toBe(DOUYIN_SIGNING_TIME_URL)
    expect(init).toMatchObject({method:'POST',redirect:'manual',body:undefined})
    expect(init!.headers).toMatchObject({Origin:'https://live.douyin.com',Referer:'https://live.douyin.com/'})
    expect(JSON.stringify(init!.headers)).not.toMatch(/Cookie|Authorization|sessionid|ticket|private|accountUid/)
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('advances trusted time only by monotonic elapsed time and expires its bounded anchor', async () => {
    const f=setup()
    expect(await f.service.timestampSeconds(signal())).toBe(seconds)
    f.setNow(wall-60_000);f.setMonotonic(3_500)
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+2)
    expect(f.request).toHaveBeenCalledOnce()
    f.advance(DOUYIN_SIGNING_TIME_TTL_MS)
    f.request.mockResolvedValue(response(String(seconds+500)))
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+500)
    expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('refreshes instead of trusting a suspended process or a backwards monotonic clock', async () => {
    const f=setup();await f.service.timestampSeconds(signal())
    f.setNow(wall+DOUYIN_SIGNING_TIME_TTL_MS+1)
    f.request.mockResolvedValue(response(String(seconds+600)))
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+600)
    f.setMonotonic(10)
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+600)
    expect(f.request).toHaveBeenCalledTimes(3)
  })
  it.each(['', 'invalid', '1794400000.5', '-1794400000', '1794400000000', '1794400000, 1794400001', '0000000000'])('rejects invalid timestamp header %s without using local wall time', async timestamp => {
    const f=setup();f.request.mockResolvedValue(response(timestamp))
    await expect(f.service.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    expect(f.request).toHaveBeenCalledOnce()
  })
  it.each([
    new Response(null), new Response(null,{status:403}), new Response(null,{status:503}),
    new Response(null,{headers:{Date:new Date(wall).toUTCString()}}),
    new Response(null,{headers:{'bd-ticket-guard-ts':String(seconds),Age:'1'}}),
    new Response(null,{status:302,headers:{Location:'https://live.douyin.com/other/','bd-ticket-guard-ts':String(seconds)}}),
  ])('rejects failure, absent clock, stale cache or redirect responses', async upstream => {
    const f=setup();f.request.mockResolvedValue(upstream)
    await expect(f.service.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('does not accept samples arriving outside the SDK response-age bound', async () => {
    const f=setup()
    f.request.mockImplementation(async () => {f.advance(2_001);return response()})
    await expect(f.service.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
  })
  it('deduplicates concurrent callers including a combined get', async () => {
    const f=setup(), ready=deferred<void>(), upstream=deferred<Response>()
    f.request.mockImplementation(async () => {ready.resolve();return upstream.promise})
    const a=f.service.timestampSeconds(signal()),b=f.service.get(signal()),c=f.service.timestampSeconds(signal())
    await ready.promise;expect(f.request).toHaveBeenCalledOnce();upstream.resolve(response())
    expect(await a).toBe(seconds);expect(await c).toBe(seconds)
    expect(await b).toMatchObject({timestampSeconds:seconds,peerPublicKeyPem:expect.stringContaining('BEGIN PUBLIC KEY')})
  })
  it('one cancelled waiter does not abort another waiter or poison the shared anchor', async () => {
    const f=setup(), ready=deferred<void>(), upstream=deferred<Response>(), owner=new AbortController()
    f.request.mockImplementation(async () => {ready.resolve();return upstream.promise})
    const cancelled=f.service.timestampSeconds(owner.signal),survivor=f.service.timestampSeconds(signal())
    const rejected=expect(cancelled).rejects.toHaveProperty('code','douyin-signing-resource-cancelled')
    await ready.promise;owner.abort('synthetic-private-reason');await rejected
    expect(f.request.mock.calls[0]![1]!.signal!.aborted).toBe(false)
    upstream.resolve(response());expect(await survivor).toBe(seconds)
    expect(await f.service.timestampSeconds(signal())).toBe(seconds);expect(f.request).toHaveBeenCalledOnce()
  })
  it('all waiters cancelling aborts the transport and late completion cannot replace a newer anchor', async () => {
    const f=setup(), ready=deferred<void>(), upstream=deferred<Response>(), owner=new AbortController()
    f.request.mockImplementationOnce(async () => {ready.resolve();return upstream.promise})
    const work=f.service.timestampSeconds(owner.signal),rejected=expect(work).rejects.toThrow('douyin-signing-resource-cancelled')
    await ready.promise;owner.abort();await rejected
    expect(f.request.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    f.request.mockResolvedValue(response(String(seconds+300)))
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+300)
    upstream.resolve(response());await new Promise(resolve=>setImmediate(resolve))
    expect(await f.service.timestampSeconds(signal())).toBe(seconds+300);expect(f.request).toHaveBeenCalledTimes(2)
  })
  it('honors pre-cancellation, invalidation and disposal', async () => {
    const f=setup(), owner=new AbortController();owner.abort()
    await expect(f.service.get(owner.signal)).rejects.toThrow('douyin-signing-resource-cancelled')
    expect(f.request).not.toHaveBeenCalled()
    await f.service.timestampSeconds(signal());f.service.invalidate()
    await f.service.timestampSeconds(signal());expect(f.request).toHaveBeenCalledTimes(2)
    f.service.dispose()
    await expect(f.service.peerPublicKey(signal())).rejects.toThrow('douyin-signing-resource-cancelled')
    await expect(f.service.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-cancelled')
  })
  it('disposal cancels an in-flight injected transport that ignores abort', async () => {
    const f=setup(), ready=deferred<void>()
    f.request.mockImplementation(async () => {ready.resolve();return new Promise(()=>{})})
    const work=f.service.timestampSeconds(signal()),rejected=expect(work).rejects.toThrow('douyin-signing-resource-cancelled')
    await ready.promise;f.service.dispose();await rejected
  })
  it('honors host allowlists and selects only one supported route candidate', async () => {
    const f=setup()
    const blocked=new DouyinSigningResources({...f.deps,proxy:{...f.deps.proxy,hosts:['example.com']}})
    await expect(blocked.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    expect(f.request).not.toHaveBeenCalled()
    const choose=new DouyinSigningResources({...f.deps,network:()=>({route:async()=>({kind:'unsupported' as const,
      alternatives:[{kind:'direct' as const},{kind:'http' as const,proxyUrl:'http://127.0.0.1:9'}]})})})
    expect(await choose.timestampSeconds(signal())).toBe(seconds);expect(f.request).toHaveBeenCalledOnce()
    const g=setup();g.request.mockRejectedValue(new Error('synthetic-private-network-failure'))
    const single=new DouyinSigningResources({...g.deps,network:()=>({route:async()=>({kind:'direct' as const,
      alternatives:[{kind:'direct' as const}]})})})
    await expect(single.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    expect(g.request).toHaveBeenCalledOnce()
  })
  it('sanitizes transport, provider and clock failures and does not retain failed flights', async () => {
    const f=setup();f.request.mockRejectedValueOnce(new Error('synthetic-secret'))
    await expect(f.service.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    expect(await f.service.timestampSeconds(signal())).toBe(seconds)
    const broken=new DouyinSigningResources({...f.deps,network:()=>{throw new Error('synthetic-provider-secret')}})
    await expect(broken.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-unavailable')
    const clock=new DouyinSigningResources({...f.deps,monotonic:()=>NaN})
    await expect(clock.timestampSeconds(signal())).rejects.toThrow('douyin-signing-resource-clock-invalid')
    const thrown=new DouyinSigningResources({...f.deps,now:()=>{throw new Error('synthetic-clock-secret')}})
    await expect(thrown.peerPublicKey(signal())).rejects.toThrow('douyin-signing-resource-clock-invalid')
    try {await broken.timestampSeconds(signal())} catch(error) {
      expect(error).toBeInstanceOf(DouyinSigningResourceError);expect(JSON.stringify(error)).not.toMatch(/synthetic|secret/)
    }
  })
})
