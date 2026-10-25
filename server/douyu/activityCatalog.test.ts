import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import { DouyuActivityCatalog, DouyuAutomationHttp, type AutomationContext } from './activityCatalog'
import type { DouyuAutomationDependencies } from './automationTypes'

const NOW = Date.UTC(2026, 9, 25, 4)
const COOKIE = 'acf_uid=42; acf_auth=fixture-auth; acf_ccn=fixture-csrf'
const context = (): AutomationContext => ({ task: { taskId: 'catalog-1', accountId: 'account-1', kind: 'points-sign', target: { type: 'account' }, options: {} }, signal: new AbortController().signal, submitted: false })
const config = (alias: string, patch: Record<string, unknown> = {}, signAlias = `${alias}_sign`) => new Response(`DYConfigCallback(${JSON.stringify({ data: {
  activity_setting: { activity_alias_name: alias, activity_id: 2439, activity_start_time: NOW / 1000 - 3600, activity_end_time: NOW / 1000 + 3600, ...patch },
  sign_setting: { sign_alias: signAlias },
} })})`)
function setup(responses: Array<Response | Error>, overrides: Partial<DouyuAutomationDependencies> = {}) {
  const queue = [...responses]
  const request = vi.fn<typeof fetch>(async () => {
    const value = queue.shift()
    if (!value) throw new Error('Unexpected fixture request')
    if (value instanceof Error) throw value
    return value
  })
  const cookieHeader = vi.fn(async () => COOKIE)
  const http = new DouyuAutomationHttp({ proxy: resolveConfig({}).proxy, cookieHeader, request, resolve: async () => ['8.8.8.8'], now: () => NOW, ...overrides })
  return { http, catalog: new DouyuActivityCatalog(http), request, cookieHeader }
}

describe('official activity catalog', () => {
  it('uses only a currently valid monthly arena configuration', async () => {
    const { catalog, request, cookieHeader } = setup([new Response('missing', { status: 404 }), config('actqzs202609')])
    expect(await catalog.arena(context(), 'actqzs')).toMatchObject({ id: '2439', alias: 'actqzs202609' })
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://webconf.douyucdn.cn/resource/common/activity/actqzs202610_w.json',
      'https://webconf.douyucdn.cn/resource/common/activity/actqzs202609_w.json',
    ])
    expect(cookieHeader).not.toHaveBeenCalled()
  })

  it.each([
    { activity_end_time: NOW / 1000 }, { activity_start_time: NOW / 1000 + 1 },
    { activity_alias_name: 'unrelated' }, { activity_id: 'https://evil.test' }, { system_switch: 0 },
  ])('never activates an invalid or expired monthly record %#', async patch => {
    const { catalog, request } = setup([config('actqzs202610', patch), new Response('', { status: 404 }), new Response('', { status: 404 })])
    await expect(catalog.arena(context(), 'actqzs')).rejects.toMatchObject({ code: 'eligibility' })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('discovers and validates a current points activity from the fixed official homepage', async () => {
    const { catalog, request } = setup([new Response('<a href="/topic/20261025POINTS">积分任务</a><a href="/topic/20261025POINTS">积分任务</a>'), config('20261025POINTS')])
    expect(await catalog.points(context())).toMatchObject({ alias: '20261025POINTS', signAlias: '20261025POINTS_sign',
      source: 'https://webconf.douyucdn.cn/resource/common/activity/20261025POINTS_w.json' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([, init]) => !new Headers(init?.headers).has('cookie'))).toBe(true)
  })

  it('reports a missing live points directory without requesting the historical alias', async () => {
    const { catalog, request } = setup([new Response('<a href="https://evil.test/topic/20250521OPFOY">积分任务</a>')])
    await expect(catalog.points(context())).rejects.toMatchObject({ code: 'unavailable' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(String(request.mock.calls[0]![0])).toBe('https://www.douyu.com/')
  })

  it('bounds distinct candidate discovery and rejects a sign alias from a different activity', async () => {
    const first = setup([new Response(Array.from({ length: 9 }, (_, index) => `<a href="/topic/activity${index}">积分</a>`).join(''))])
    await expect(first.catalog.points(context())).rejects.toMatchObject({ code: 'capacity' })
    expect(first.request).toHaveBeenCalledTimes(1)
    const second = setup([new Response('<a href="/topic/CURRENT">积分</a>'), config('CURRENT', {}, 'UNRELATED_sign')])
    await expect(second.catalog.points(context())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not execute JSONP or accept a JavaScript suffix', async () => {
    const { catalog } = setup([new Response('DYConfigCallback({"data":{}}); fetch("https://evil.test/")'), new Response('', { status: 404 }), new Response('', { status: 404 })])
    await expect(catalog.arena(context(), 'actqzs')).rejects.toMatchObject({ code: 'eligibility' })
  })
})

describe('automation transport boundary', () => {
  it('rejects a scoped cookie from another session before a write', async () => {
    const { http, request } = setup([], { cookieHeader: async (_account, url) => url.endsWith('/') ? COOKIE : COOKIE.replace('fixture-auth', 'other-auth') })
    await expect(http.request(context(), 'https://www.douyu.com/japi/interactnc/web/fanshome/sign', { method: 'POST', fields: { rid: '123' } })).rejects.toMatchObject({ code: 'login' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['https://evil.test/action', 'http://www.douyu.com/action', 'https://www.douyu.com:444/action', 'https://u:p@www.douyu.com/action'])('rejects an unsafe destination %s', async url => {
    const { http, request } = setup([])
    await expect(http.request(context(), url)).rejects.toMatchObject({ code: 'unavailable' })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses private DNS targets and duplicate response keys', async () => {
    const first = setup([], { resolve: async () => ['8.8.8.8', '127.0.0.1'] })
    await expect(first.http.request(context(), 'https://www.douyu.com/test')).rejects.toMatchObject({ reason: 'dns-failed' })
    expect(first.request).not.toHaveBeenCalled()
    const second = setup([new Response('{"error":1,"error":0,"data":{}}')])
    await expect(second.http.request(context(), 'https://www.douyu.com/test')).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('does not follow a login redirect or expose upstream response text', async () => {
    const { http } = setup([new Response('fixture-private-upstream', { status: 302, headers: { location: 'https://evil.test/' } })])
    await expect(http.request(context(), 'https://www.douyu.com/test')).rejects.toMatchObject({ reason: 'too-many-redirects' })
  })
})
