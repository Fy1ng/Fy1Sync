import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { directNetwork } from '../networkPolicy'
import { acquireDouyinHttpToken, DOUYIN_HTTP_TOKEN_URL } from './httpToken'

const TOKEN = 'a'.repeat(162) + '=='
function setup(response = new Response(null,{ headers:{ 'x-ms-token':TOKEN,'set-cookie':`msToken=${TOKEN}; Domain=.bytedance.com; Path=/; Secure` } })) {
  const request = vi.fn(async (_input: unknown,_init?: RequestInit) => response)
  const deps = { proxy:resolveConfig({}).proxy, network:() => directNetwork, resolve:async () => ['93.184.216.34'], fetchImpl:request as typeof fetch, now:() => 1794384000000 }
  return { request,deps }
}
describe('Douyin anonymous HTTP security token', () => {
  it('requests a fresh token without login credentials, account IDs, message text or a seed token', async () => {
    const f = setup()
    expect(await acquireDouyinHttpToken(f.deps,new AbortController().signal)).toBe(TOKEN)
    expect(f.request).toHaveBeenCalledOnce()
    const [input,init] = f.request.mock.calls[0]!
    expect(String(input)).toBe(DOUYIN_HTTP_TOKEN_URL)
    expect(init).toMatchObject({ method:'POST',redirect:'manual' })
    expect(Object.keys(init!.headers!)).not.toContain('Cookie')
    expect(JSON.stringify(init!.headers)).not.toMatch(/sessionid|Authorization/)
    const payload = JSON.parse(String(init!.body)) as Record<string,unknown>
    expect(payload).toMatchObject({ magic:538969122,version:1,dataType:8,tspFromClient:1794384000000 })
    expect(payload).not.toHaveProperty('msToken')
    expect(payload).not.toHaveProperty('room_id')
    expect(payload).not.toHaveProperty('content')
  })
  it('accepts a token supplied only by the official response cookie', async () => {
    const f = setup(new Response(null,{ headers:{ 'set-cookie':`msToken=${TOKEN}; Domain=.bytedance.com; Path=/` } }))
    expect(await acquireDouyinHttpToken(f.deps,new AbortController().signal)).toBe(TOKEN)
  })
  it.each([
    new Response(null,{ status:503 }), new Response(null), new Response(null,{ headers:{ 'x-ms-token':'short' } }),
    new Response(null,{ headers:{ 'x-ms-token':'!'.repeat(164) } }),
    new Response(null,{ headers:{ 'x-ms-token':TOKEN,'set-cookie':`msToken=${'b'.repeat(164)}; Path=/` } }),
  ])('rejects failed, absent, invalid or contradictory token responses', async response => {
    const f = setup(response)
    await expect(acquireDouyinHttpToken(f.deps,new AbortController().signal)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledOnce()
  })
  it('honors the host policy and does not follow redirects', async () => {
    const f = setup(new Response(null,{ status:302,headers:{ location:'https://mssdk.bytedance.com/web/r/token?redirected=1' } }))
    await expect(acquireDouyinHttpToken(f.deps,new AbortController().signal)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledOnce()
    const g = setup()
    await expect(acquireDouyinHttpToken({ ...g.deps,proxy:{ ...g.deps.proxy,hosts:['live.douyin.com'] } },new AbortController().signal)).rejects.toThrow()
    expect(g.request).not.toHaveBeenCalled()
  })
  it('bounds cancellation even if an injected transport ignores abort', async () => {
    const f = setup(), controller = new AbortController()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    f.request.mockImplementation(async () => { started(); return new Promise(() => {}) })
    const work = acquireDouyinHttpToken(f.deps,controller.signal)
    await ready; controller.abort()
    await expect(work).rejects.toHaveProperty('name','AbortError')
    expect(f.request).toHaveBeenCalledOnce()
  })
})
