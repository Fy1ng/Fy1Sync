/** The renderer forwards IPC contracts and preserves actionable storage failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { ApiClient, type ApiResult, type DanmakuEvent } from './apiClient'
import { DOUYIN_LOGIN_CHANGED_EVENT } from '../core/douyinMessage'


function bridgeWith(result: ApiResult<unknown>): StreamSyncerBridge {
  return {
    invoke: vi.fn(async () => result) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: vi.fn(() => () => {}),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('ApiClient IPC failures', () => {

  it('keeps caller authorization failures distinct from IPC failures', async () => {
    const bridge = bridgeWith({ ok: false, code: 'forbidden', message: '调用来源不受信任' })
    expect(await new ApiClient({ bridge }).health()).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('maps rejected IPC calls into a result instead of throwing', async () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    vi.mocked(bridge.invoke).mockRejectedValue(new Error('channel closed'))
    const result = await new ApiClient({ bridge }).health()
    expect(result).toMatchObject({ ok: false, code: 'ipc-error' })
    if (result.ok) throw new Error('expected failure')
    expect(result.message).toContain('无法连接 Fy1Sync')
  })

  it('reports a missing preload without attempting HTTP', async () => {
    vi.stubGlobal('streamSyncer', undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new ApiClient().health()).toMatchObject({ ok: false, code: 'ipc-error' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ApiClient IPC arguments', () => {
  it('notifies Douyin consumers after the login IPC has settled, including cancellation',async()=>{
    const bridge=bridgeWith({ok:true,value:{cookieCount:1,authKeysPresent:['sessionid']}})
    let finish!:(value:Awaited<ReturnType<StreamSyncerBridge['invoke']>>)=>void
    vi.mocked(bridge.invoke).mockReturnValue(new Promise<Awaited<ReturnType<StreamSyncerBridge['invoke']>>>(resolve=>{finish=resolve}))
    const client=new ApiClient({bridge}),listener=vi.fn()
    window.addEventListener(DOUYIN_LOGIN_CHANGED_EVENT,listener)
    try{
      const pending=client.login('douyin')
      expect(listener).not.toHaveBeenCalled()
      finish({ok:false,code:'login-cancelled',message:'已取消'})
      await pending
      expect(listener).toHaveBeenCalledOnce()
    }finally{window.removeEventListener(DOUYIN_LOGIN_CHANGED_EVENT,listener)}
  })
  it('reads acquisition diagnostics without forwarding renderer state or optional arguments', async () => {
    const report = { schemaVersion: 1, attempts: [] }
    const bridge = bridgeWith({ ok: true, value: report })
    expect(await new ApiClient({ bridge }).getAcquisitionDiagnostics()).toEqual({ ok: true, value: report })
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('getAcquisitionDiagnostics', undefined)
  })

  it('forwards an explicit account and room for a single message', async () => {
    const outcome = { status: 'waiting-user', message: '请到官方房间核对.', nextAllowedAt: null }
    const bridge = bridgeWith({ ok: true, value: outcome })
    const input = { accountId: 'default', room: '9999', text: '原文 @/', color: 0 }
    expect(await new ApiClient({ bridge }).sendDouyuMessage(input)).toEqual({ ok: true, value: outcome })
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('sendDouyuMessage', input)
  })

  it('forwards typed decoder preferences over the narrow bridge', async () => {
    const state = { mode: 'software', effectiveMode: 'auto', restartRequired: true, forcedByCommandLine: false }
    const bridge = bridgeWith({ ok: true, value: state })
    const client = new ApiClient({ bridge })
    expect(await client.getDecoderPreferences()).toEqual({ ok: true, value: state })
    expect(bridge.invoke).toHaveBeenLastCalledWith('getDecoderPreferences', undefined)
    expect(await client.setDecoderPreferences('software')).toEqual({ ok: true, value: state })
    expect(bridge.invoke).toHaveBeenLastCalledWith('setDecoderPreferences', { mode: 'software' })
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
    expect(await client.health()).toEqual({ ok: true, value: { presets: [] } })
    expect(bridge.invoke).toHaveBeenCalledWith('health', undefined)
  })

  it('only forwards an adaptive preference when the caller supplies it', async () => {
    const bridge = bridgeWith({ ok: true, value: {} })
    const client = new ApiClient({ bridge })
    await client.resolve('https://www.youtube.com/watch?v=example', 'youtube', 'official', undefined, true)
    expect(bridge.invoke).toHaveBeenLastCalledWith('resolve', {
      input: 'https://www.youtube.com/watch?v=example', platform: 'youtube', role: 'official', preferAdaptive: true,
    })
    await client.resolve('https://www.youtube.com/watch?v=example', 'youtube', 'official')
    expect(bridge.invoke).toHaveBeenLastCalledWith('resolve', {
      input: 'https://www.youtube.com/watch?v=example', platform: 'youtube', role: 'official',
    })
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
