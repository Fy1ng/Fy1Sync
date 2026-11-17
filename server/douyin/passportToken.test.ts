import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { directNetwork } from '../networkPolicy'
import profile from './fixtures/passport-dtrait-profile.json'
import { acquireDouyinPassportToken } from './passportToken'

function setup(response: Response) {
  const transport = vi.fn(async () => response)
  return { transport, deps: { proxy: { ...resolveConfig({}).proxy,hosts:['mssdk.bytedance.com'] }, network: () => directNetwork,
    userAgent:profile.ua, now:() => 1790000000123, resolve:async () => ['93.184.216.34'], fetchImpl:transport as typeof fetch } }
}
describe('anonymous passport token preparation', () => {
  it('updates only the supplied visitor token with an anonymous report and no account credentials', async () => {
    const token = 's'.repeat(172), f = setup(new Response(null,{headers:{'x-ms-token':token}}))
    expect(await acquireDouyinPassportToken(f.deps,new AbortController().signal,'i'.repeat(164))).toBe(token)
    expect(f.transport).toHaveBeenCalledOnce()
    const [input,init] = f.transport.mock.calls[0]! as unknown as [URL,RequestInit]
    expect(input.origin + input.pathname).toBe('https://mssdk.bytedance.com/web/common')
    expect(input.searchParams.get('msToken')).toBe('i'.repeat(164))
    expect(init).toMatchObject({method:'POST',redirect:'manual'})
    const headers = new Headers(init.headers)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.get('user-agent')).toBe(profile.ua)
    expect(headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    expect(JSON.parse(String(init.body))).toMatchObject({magic:538969122,version:1,dataType:8})
  })

  it.each([new Response(null,{status:503}),new Response(null,{status:302,headers:{location:'https://untrusted.invalid/'}}),
    new Response(null),new Response(null,{headers:{'x-ms-token':'s'.repeat(164)}}),new Response(null,{headers:{'x-ms-token':'!'.repeat(172)}}),
    new Response(null,{headers:{'x-ms-token':'s'.repeat(172),'set-cookie':'msToken='+'d'.repeat(172)+'; Path=/'}}),
  ])('does not fall back to a short or invalid token after failed preparation', async response => {
    const f = setup(response)
    await expect(acquireDouyinPassportToken(f.deps,new AbortController().signal,'i'.repeat(164))).rejects.toThrow()
    expect(f.transport).toHaveBeenCalledOnce()
  })

  it('honors host policy and cancellation without a credential dispatch or retry', async () => {
    const f = setup(new Response(null,{headers:{'x-ms-token':'s'.repeat(172)}}))
    await expect(acquireDouyinPassportToken({...f.deps,proxy:{...f.deps.proxy,hosts:['live.douyin.com']}},new AbortController().signal,'i'.repeat(164))).rejects.toThrow()
    expect(f.transport).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = vi.fn(async () => new Promise<Response>(() => {}))
    const work = acquireDouyinPassportToken({...f.deps,fetchImpl:pending},controller.signal,'i'.repeat(164))
    const failed = expect(work).rejects.toHaveProperty('name','AbortError')
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce())
    controller.abort(); await failed
    expect(pending).toHaveBeenCalledOnce()
  })
})
