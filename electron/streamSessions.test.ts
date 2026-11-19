import { describe, expect, it, vi } from 'vitest'
import { StreamSessions } from './streamSessions'
import type { StreamId } from './streamIdentity'
import type { ResolveResult, ResolvedStream } from '../server/platforms'
import { StreamFailureError } from '../server/networkFailure'

function fixture() {
  let sequence = 0
  const selected = new Map<StreamId, ResolvedStream>()
  const source = (id: StreamId): ResolvedStream => ({ platform: 'direct', channel: 'fixture', kind: 'hls',
    url: `app://app/buffer/session/${id}/generation/index.m3u8`, label: id, requiresProxy: false })
  const port = {
    resolve: vi.fn(async (_input: string, _platform: unknown, id: StreamId): Promise<ResolveResult> => {
      const stream = source(id); selected.set(id, stream); return { ok: true, stream }
    }),
    switchQuality: vi.fn(async (id: StreamId): Promise<ResolveResult> => ({ ok: true, stream: source(id) })),
    restart: vi.fn(async (id: StreamId): Promise<ResolveResult> => ({ ok: true, stream: source(id) })),
    stop: vi.fn(async (id: StreamId) => { selected.delete(id) }),
    subscribe: vi.fn(() => () => {}), describe: (id: StreamId) => selected.get(id) ?? null,
  }
  const manager = new StreamSessions(port, 4, () => `stream-${String(++sequence).padStart(32, '0')}`)
  return { manager, port, source }
}
describe('independent stream sessions', () => {
  it('supports unlimited and user-selected counts without a fixed 256 ceiling and masks input credentials', async () => {
    const f = fixture()
    let maximum = 0, sequence = 0
    const manager = new StreamSessions(f.port, () => maximum, () => `stream-${String(++sequence).padStart(32, '0')}`)
    const listener = vi.fn()
    manager.subscribe(listener)
    for (let index = 0; index < 18; index++) await manager.open({ input: 'http://user:password@media.invalid/live.mp4' })
    expect(manager.snapshot()).toMatchObject({ maxExtraStreams: 0, sessions: expect.any(Array) })
    expect(manager.snapshot().sessions).toHaveLength(18)
    expect(JSON.stringify(manager.snapshot())).not.toContain('password')
    maximum = 300
    manager.refreshLimits()
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ maxExtraStreams: 300 }))
    maximum = 18
    await expect(manager.open({ input: 'another' })).rejects.toMatchObject({ code: 'stream-limit' })
    await manager.dispose(); await f.manager.dispose()
  })

  it('accepts long signed source URLs within the memory bound', async () => {
    const f = fixture()
    const input = 'https://media.invalid/live?signature=' + 's'.repeat(16000)
    expect((await f.manager.open({ input })).phase).toBe('ready')
    expect(f.port.resolve).toHaveBeenCalledWith(input, undefined, expect.any(String), undefined, undefined)
    await f.manager.dispose()
  })
  it.each([
    [Object.assign(new Error('Cookie=PRIVATE https://signed.invalid/?token=PRIVATE'), { code: 'ENOTFOUND' }), '域名解析失败'],
    [new StreamFailureError({ stage: 'proxy', code: 'proxy-unreachable', message: 'original proxy failure' }), '无法连接取流代理'],
    [Object.assign(new Error('original certificate failure'), { code: 'CERT_HAS_EXPIRED' }), '服务器证书校验失败'],
    [{ status: 403, message: 'original HTTP failure' }, '服务器返回 HTTP 403'],
  ])('preserves the classified acquisition failure without leaking diagnostics', async (error, message) => {
    const f = fixture()
    f.port.resolve.mockRejectedValueOnce(error)
    const opened = await f.manager.open({ input: 'one' })
    expect(opened).toMatchObject({ phase: 'failed', error: message })
    expect(opened.error).not.toMatch(/PRIVATE|signed\.invalid|token=|Cookie|original/)
    expect(JSON.stringify(opened.errorDetail)).not.toContain('PRIVATE')
    expect(opened.errorDetail).toBeDefined()
    await f.manager.dispose()
  })
  it('accepts Huya room selections at the main-process session boundary', async () => {
    const f = fixture()
    const view = await f.manager.open({ input: '  huya.com/660000  ', platform: 'huya', quality: '8000' })
    expect(view.phase).toBe('ready')
    expect(f.port.resolve).toHaveBeenCalledWith('huya.com/660000', 'huya', view.id, '8000', undefined)
    await f.manager.dispose()
  })
  it('accepts Douyin room selections and quality changes for an independent stream', async () => {
    const f = fixture()
    const view = await f.manager.open({ input: '  live.douyin.com/100  ', platform: 'douyin', quality: 'origin' })
    expect(view.phase).toBe('ready')
    expect(f.port.resolve).toHaveBeenCalledWith('live.douyin.com/100', 'douyin', view.id, 'origin', undefined)
    await f.manager.switchQuality(view.id, 'hd')
    expect(f.port.switchQuality).toHaveBeenCalledWith(view.id, 'hd')
    await f.manager.dispose()
  })
  it('opens more than two streams and closes only the selected producer', async () => {
    const f = fixture()
    const streams = await Promise.all(['one', 'two', 'three'].map(input => f.manager.open({ input })))
    expect(new Set(streams.map(s => s.id)).size).toBe(3)
    await f.manager.switchQuality(streams[1]!.id, '720')
    expect(f.port.switchQuality).toHaveBeenCalledWith(streams[1]!.id, '720')
    await f.manager.close(streams[0]!.id)
    expect(f.manager.snapshot().sessions.map(s => s.id)).toEqual(streams.slice(1).map(s => s.id))
    expect(f.port.stop).toHaveBeenCalledTimes(1)
    await f.manager.dispose()
    expect(f.port.stop).toHaveBeenCalledTimes(3)
    expect(f.port.stop.mock.calls.flat()).not.toContain('official')
  })
  it('reserves capacity during lookup and rejects late results after close', async () => {
    const f = fixture()
    let settle!: (value: ResolveResult) => void
    f.port.resolve.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const pending = f.manager.open({ input: 'one' })
    const outcome = expect(pending).rejects.toMatchObject({ code: 'stream-cancelled' })
    const id = f.manager.snapshot().sessions[0]!.id
    await f.manager.close(id)
    settle({ ok: true, stream: f.source(id) })
    await outcome
    expect(f.manager.snapshot().sessions).toEqual([])
    await f.manager.dispose()
  })
  it('rejects traversal, invalid platform and mutation of the synchronization roles', async () => {
    const f = fixture()
    await expect(f.manager.close('official')).rejects.toMatchObject({ code: 'invalid-arguments' })
    await expect(f.manager.open({ input: 'x', platform: 'bad' as 'direct' })).rejects.toMatchObject({ code: 'invalid-arguments' })
    await expect(f.manager.close('../x' as StreamId)).rejects.toMatchObject({ code: 'invalid-arguments' })
    expect(f.port.stop).not.toHaveBeenCalled()
    await f.manager.dispose()
  })
  it('returns detached snapshots and bounds concurrent resource reservations', async () => {
    const f = fixture()
    await Promise.all(['1', '2', '3', '4'].map(input => f.manager.open({ input })))
    f.manager.snapshot().sessions.length = 0
    await expect(f.manager.open({ input: '5' })).rejects.toMatchObject({ code: 'stream-limit' })
    expect(f.manager.snapshot().sessions).toHaveLength(4)
    await f.manager.dispose()
  })
})
