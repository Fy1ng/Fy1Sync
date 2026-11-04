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
  it.each([
    [Object.assign(new Error('Cookie=PRIVATE https://signed.invalid/?token=PRIVATE'), { code: 'ENOTFOUND' }), '域名解析失败.'],
    [new StreamFailureError({ stage: 'proxy', code: 'proxy-unreachable', message: 'PRIVATE' }), '代理不可达, 请检查系统代理.'],
    [Object.assign(new Error('PRIVATE'), { code: 'CERT_HAS_EXPIRED' }), '服务器证书校验失败.'],
    [{ status: 403, message: 'PRIVATE' }, '服务器返回 HTTP 403.'],
  ])('preserves the classified acquisition failure without leaking diagnostics', async (error, message) => {
    const f = fixture()
    f.port.resolve.mockRejectedValueOnce(error)
    const opened = await f.manager.open({ input: 'one' })
    expect(opened).toMatchObject({ phase: 'failed', error: message })
    expect(JSON.stringify(opened)).not.toMatch(/PRIVATE|signed\.invalid|token=|Cookie/)
    await f.manager.dispose()
  })
  it('accepts Huya room selections at the main-process session boundary', async () => {
    const f = fixture()
    const view = await f.manager.open({ input: '  huya.com/660000  ', platform: 'huya', quality: '8000' })
    expect(view.phase).toBe('ready')
    expect(f.port.resolve).toHaveBeenCalledWith('huya.com/660000', 'huya', view.id, '8000', undefined)
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
