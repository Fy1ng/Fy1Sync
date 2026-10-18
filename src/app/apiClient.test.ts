/** The renderer forwards IPC contracts and preserves actionable storage failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { ApiClient, issuesFrom, type ApiResult, type DanmakuEvent } from './apiClient'
import type { RecognitionProfile } from '../core/profileSchema'

const PROFILE = { id: 'cs2/iem', name: '测试' } as unknown as RecognitionProfile

function bridgeWith(result: ApiResult<unknown>): StreamSyncerBridge {
  return {
    invoke: vi.fn(async () => result) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: vi.fn(() => () => {}),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('ApiClient IPC failures', () => {
  it('preserves conflict and the current ETag for a stale editor', async () => {
    const bridge = bridgeWith({
      ok: false, code: 'conflict', message: '预设已被其他会话修改', detail: { currentEtag: 'abc' },
    })
    const result = await new ApiClient({ bridge }).savePreset('cs2/iem', PROFILE, '', 'stale')
    expect(result).toEqual({
      ok: false, code: 'conflict', message: '预设已被其他会话修改', detail: { currentEtag: 'abc' },
    })
  })

  it('preserves profile validation detail for issuesFrom', async () => {
    const bridge = bridgeWith({
      ok: false, code: 'invalid-profile', message: '配置校验未通过',
      detail: { issues: [{ path: 'roi.w', message: '必须大于 0' }] },
    })
    const result = await new ApiClient({ bridge }).savePreset('cs2/iem', PROFILE)
    if (result.ok) throw new Error('expected failure')
    expect(result.code).toBe('invalid-profile')
    expect(issuesFrom(result.detail)).toEqual([{ path: 'roi.w', message: '必须大于 0' }])
  })

  it('keeps caller authorization failures distinct from IPC failures', async () => {
    const bridge = bridgeWith({ ok: false, code: 'forbidden', message: '调用来源不受信任' })
    expect(await new ApiClient({ bridge }).savePreset('cs2/iem', PROFILE)).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('maps rejected IPC calls into a result instead of throwing', async () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    vi.mocked(bridge.invoke).mockRejectedValue(new Error('channel closed'))
    const result = await new ApiClient({ bridge }).health()
    expect(result).toMatchObject({ ok: false, code: 'ipc-error' })
    if (result.ok) throw new Error('expected failure')
    expect(result.message).toContain('无法连接应用主进程')
  })

  it('reports a missing preload without attempting HTTP', async () => {
    vi.stubGlobal('streamSyncer', undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new ApiClient().listPresets()).toMatchObject({ ok: false, code: 'ipc-error' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ApiClient IPC arguments', () => {
  it('forwards the exact profile and ETag as structured values', async () => {
    const bridge = bridgeWith({ ok: true, value: { id: 'cs2/iem', etag: 'new', updatedAt: 1 } })
    await new ApiClient({ bridge }).savePreset('cs2/iem', PROFILE, '', 'abc123')
    expect(bridge.invoke).toHaveBeenCalledWith('savePreset', {
      id: 'cs2/iem', profile: PROFILE, token: '', etag: 'abc123',
    })
  })

  it('leaves the ETag absent for a new preset', async () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    await new ApiClient({ bridge }).savePreset('cs2/iem', PROFILE)
    expect(bridge.invoke).toHaveBeenCalledWith('savePreset', {
      id: 'cs2/iem', profile: PROFILE, token: '', etag: undefined,
    })
  })

  it('passes preset ids as data without URL escaping', async () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    await new ApiClient({ bridge }).getPreset('cs2/iem 决赛')
    expect(bridge.invoke).toHaveBeenCalledWith('getPreset', { id: 'cs2/iem 决赛' })
  })

  it('uses the local editor authorization seam without requiring a token', async () => {
    const bridge = bridgeWith({ ok: true, value: { ok: true } })
    await new ApiClient({ bridge }).verifyAdmin()
    expect(bridge.invoke).toHaveBeenCalledWith('verifyAdmin', { token: '' })
  })

  it('registers a remote URL through main and preserves a platform refusal', async () => {
    const refusal = { ok: false, failure: { code: 'offline', message: '未开播' } }
    const bridge = bridgeWith({ ok: true, value: refusal })
    const result = await new ApiClient({ bridge }).resolve('https://example.com/live.m3u8', 'direct')
    expect(bridge.invoke).toHaveBeenCalledWith('resolve', {
      input: 'https://example.com/live.m3u8', platform: 'direct',
    })
    expect(result).toEqual({ ok: true, value: refusal })
  })

  it('finds the preload lazily so importing the singleton needs no window', async () => {
    const client = new ApiClient()
    const bridge = bridgeWith({ ok: true, value: { presets: [] } })
    vi.stubGlobal('streamSyncer', bridge)
    expect(await client.listPresets()).toEqual({ ok: true, value: { presets: [] } })
    expect(bridge.invoke).toHaveBeenCalledWith('listPresets', undefined)
  })
})

describe('ApiClient danmaku subscriptions', () => {
  it('unsubscribes once and discards events already queued at cancellation', () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    const release = vi.fn()
    let deliver: ((event: DanmakuEvent) => void) | undefined
    vi.mocked(bridge.subscribeDanmaku).mockImplementation((_room, listener) => {
      deliver = listener
      return release
    })
    const listener = vi.fn()
    const unsubscribe = new ApiClient({ bridge }).subscribeDanmaku('288016', listener)
    deliver?.({ event: 'state', data: { state: 'connected' } })
    unsubscribe()
    unsubscribe()
    deliver?.({ event: 'danmaku', data: { text: 'late' } })
    expect(bridge.subscribeDanmaku).toHaveBeenCalledWith('288016', expect.any(Function))
    expect(release).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('issuesFrom', () => {
  it('rejects malformed issue shapes without throwing', () => {
    expect(issuesFrom(undefined)).toEqual([])
    expect(issuesFrom({ issues: 'nope' })).toEqual([])
    expect(issuesFrom({ issues: [{ path: 1 }, null, 'x'] })).toEqual([])
  })
})
