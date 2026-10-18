/**
 * What the UI is allowed to branch on when a call fails.
 *
 * `ApiClient` never throws; it returns `{ ok: false, code, message }`, and the pages key
 * their copy off `code`. That makes the code string a contract between the server's error
 * envelope and the UI, and nothing was holding the two ends together: `AdminPage` tested
 * for `etag-mismatch` while the server has always sent `conflict`, so a stale publish
 * showed the raw server text instead of telling the user to reload first. The branch was
 * dead for as long as it existed and only an E2E assertion on the rendered string caught
 * it.
 *
 * These tests feed the envelopes `server/api.ts` actually sends. Codes asserted here are
 * mirrored by `server/server.test.ts`; if one side is renamed, both fail.
 */

import { describe, expect, it, vi } from 'vitest'

import { ApiClient, issuesFrom } from './apiClient'
import type { RecognitionProfile } from '../core/profileSchema'

/** Enough of a profile to post; the body is never inspected by these fakes. */
const PROFILE = { id: 'cs2/iem', name: '测试' } as unknown as RecognitionProfile

/** A fetch that answers every request with one canned response. */
function respondWith(body: unknown, status: number, contentType = 'application/json'): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    }),
  ) as unknown as typeof fetch
}

describe('ApiClient 失败映射', () => {
  it('把 409 的 conflict 原样交给界面', async () => {
    const client = new ApiClient({
      fetchImpl: respondWith(
        { error: { code: 'conflict', message: '预设已被其他会话修改', currentEtag: 'abc' } },
        409,
      ),
    })

    const result = await client.savePreset('cs2/iem', PROFILE, 'token', 'stale-etag')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // AdminPage's "reload before republishing" message hangs off exactly this string.
    expect(result.code).toBe('conflict')
    expect(result.message).toBe('预设已被其他会话修改')
  })

  it('把 422 的校验问题带在 detail 上，供 issuesFrom 取出', async () => {
    const client = new ApiClient({
      fetchImpl: respondWith(
        {
          error: {
            code: 'invalid-profile',
            message: '配置校验未通过',
            issues: [{ path: 'roi.w', message: '必须大于 0' }],
          },
        },
        422,
      ),
    })

    const result = await client.savePreset('cs2/iem', PROFILE, 'token')
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('invalid-profile')
    expect(issuesFrom(result.detail)).toEqual([{ path: 'roi.w', message: '必须大于 0' }])
  })

  it('令牌不对时报出 bad-token 而不是通用错误', async () => {
    // 403 + bad-token is what the admin guard sends, for both a missing and a wrong token.
    const client = new ApiClient({
      fetchImpl: respondWith({ error: { code: 'bad-token', message: '需要管理令牌' } }, 403),
    })

    const result = await client.savePreset('cs2/iem', PROFILE, '')
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('bad-token')
  })

  it('服务不可达时区分成 network-error', async () => {
    const client = new ApiClient({
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch,
    })

    const result = await client.health()
    if (result.ok) throw new Error('expected failure')
    // Not an HTTP status at all — the local server isn't running, which is its own fix.
    expect(result.code).toBe('network-error')
    expect(result.message).toContain('无法连接本地服务')
  })

  it('非 JSON 响应归到 bad-response，而不是当成解析失败', async () => {
    // A dev-server HTML fallback answering an /api path looks like this.
    const client = new ApiClient({ fetchImpl: respondWith('<!doctype html><title>404</title>', 200, 'text/html') })

    const result = await client.listPresets()
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('bad-response')
  })

  it('错误体没有 code 时退回 http-error', async () => {
    const client = new ApiClient({ fetchImpl: respondWith({}, 500) })

    const result = await client.getPreset('cs2/iem')
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('http-error')
    expect(result.message).toContain('500')
  })
})

describe('ApiClient 请求构造', () => {
  it('把 etag 作为带引号的 If-Match 发出', async () => {
    const fetchImpl = respondWith({ id: 'cs2/iem', etag: 'new', updatedAt: 1 }, 200)
    const client = new ApiClient({ fetchImpl })

    await client.savePreset('cs2/iem', PROFILE, 'secret', 'abc123')

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    // Unquoted, the server's `replace(/"/g, '')` still matches, but the header would be
    // an invalid entity-tag; quoting keeps it a legal If-Match.
    expect(headers['if-match']).toBe('"abc123"')
    expect(headers['x-admin-token']).toBe('secret')
  })

  it('没有 etag 时不发 If-Match，让首次创建通过', async () => {
    const fetchImpl = respondWith({ id: 'cs2/iem', etag: 'new', updatedAt: 1 }, 201)
    const client = new ApiClient({ fetchImpl })

    await client.savePreset('cs2/iem', PROFILE, 'secret')

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(init.headers as Record<string, string>).not.toHaveProperty('if-match')
  })

  it('预设 id 里的斜杠保留成路径，其余字符转义', async () => {
    const fetchImpl = respondWith({ profile: PROFILE, etag: 'e' }, 200)
    const client = new ApiClient({ fetchImpl })

    await client.getPreset('cs2/iem 决赛')

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    // The slash is route structure the server matches on; the space is data.
    expect(url).toBe('/api/presets/cs2/iem%20%E5%86%B3%E8%B5%9B')
  })

  it('令牌走请求体而不是查询串，避免留在日志里', async () => {
    const fetchImpl = respondWith({ ok: true }, 200)
    const client = new ApiClient({ fetchImpl })

    await client.verifyAdmin('secret')

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/admin/verify')
    expect(url).not.toContain('secret')
    expect(JSON.parse(init.body as string)).toEqual({ token: 'secret' })
  })
})

describe('issuesFrom', () => {
  it('形状不对时给空数组而不是抛错', () => {
    expect(issuesFrom(undefined)).toEqual([])
    expect(issuesFrom({ issues: 'nope' })).toEqual([])
    expect(issuesFrom({ issues: [{ path: 1 }, null, 'x'] })).toEqual([])
  })
})
