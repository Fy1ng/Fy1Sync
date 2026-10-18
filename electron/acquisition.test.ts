import { describe, expect, it, vi } from 'vitest'
import type { BufferInput, BufferState } from './bufferManager'
import { Acquisition } from './acquisition'
import { resolveConfig } from '../server/config'
import { createDesktopService } from '../server/api'

function harness() {
  const listeners = new Set<(state: BufferState) => void>()
  const inputs: BufferInput[] = []
  let resolver: (() => Promise<BufferInput>) | undefined
  const emit = (state: BufferState) => { for (const listener of listeners) listener(state) }
  const buffer = {
    subscribe: (listener: (state: BufferState) => void) => {
      listeners.add(listener)
      listener({ role: 'official', state: 'ready', seconds: 99 })
      return () => { listeners.delete(listener) }
    },
    start: vi.fn(async (role, prepare) => {
      resolver = prepare
      emit({ role, state: 'starting', seconds: 0 })
      inputs.push(await prepare())
      emit({ role, state: 'ready', seconds: 6 })
      return { url: `app://app/buffer/session/${role}/generation/index.m3u8` }
    }),
    stop: vi.fn(async () => {}),
  }
  const logins = {
    cookieHeader: vi.fn(async () => ''), login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn(),
  }
  const runYtDlp = vi.fn(async () => ({ is_live: true, id: 'abcdefghijk', live_status: 'is_live', formats: [
    { format_id: '301', protocol: 'm3u8_native', height: 1080, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/live.m3u8?signature=PRIVATE' },
    { format_id: '300', protocol: 'm3u8_native', height: 720, fps: 60, vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', url: 'https://media.googlevideo.com/low.m3u8' },
  ] }))
  const proxy = { ...resolveConfig({}).proxy, hosts: ['*'] }
  const acquisition = new Acquisition({ buffer, logins, runYtDlp, proxy, dns: async () => ['8.8.8.8'] })
  return { acquisition, buffer, logins, inputs, runYtDlp, proxy, emit, listeners,
    reconnect: async () => resolver!() }
}

describe('main acquisition boundary', () => {
  it('returns only a local playlist and quality metadata, never the signed input', async () => {
    const h = harness()
    const result = await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    expect(result).toMatchObject({ ok: true, stream: { kind: 'hls', url: expect.stringContaining('app://app/buffer/'), quality: '301' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(h.inputs[0]!.url).toContain('signature=PRIVATE')
    expect(h.listeners.size).toBe(0)
  })

  it('resolves again on reconnect and on each role quality change', async () => {
    const h = harness()
    await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    await h.reconnect()
    expect(h.runYtDlp).toHaveBeenCalledTimes(2)
    const result = await h.acquisition.switchQuality('official', '300')
    expect(result).toMatchObject({ ok: true, stream: { quality: '300' } })
    expect(h.inputs.at(-1)?.url).toContain('/low.m3u8')
    expect(h.runYtDlp).toHaveBeenCalledTimes(3)
  })

  it.each(['http://127.0.0.1/x.mp4', 'http://169.254.169.254/x.m3u8', 'https://user:password@8.8.8.8/x.flv'])('rejects untrusted direct input %s before spawning', async (input) => {
    const h = harness()
    await expect(h.acquisition.resolve(input, 'direct', 'official')).rejects.toHaveProperty('reason')
    expect(h.buffer.start).not.toHaveBeenCalled()
  })

  it('routes direct FLV through ffmpeg and stops the producer for a local fixture', async () => {
    const h = harness()
    expect(await h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'commentary')).toMatchObject({ ok: true, stream: { kind: 'hls' } })
    await h.acquisition.resolve('/test-sources/official.mp4', 'direct', 'commentary')
    expect(h.buffer.stop).toHaveBeenCalledWith('commentary')
    expect(h.buffer.start).toHaveBeenCalledTimes(1)
    expect((await h.acquisition.switchQuality('commentary', '0')).ok).toBe(false)
  })

  it('cancels a slow source resolution when the role is unloaded', async () => {
    const h = harness()
    let complete!: (value: unknown) => void
    h.runYtDlp.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }) as any)
    const operation = h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    await vi.waitFor(() => expect(h.runYtDlp).toHaveBeenCalledTimes(1))
    await h.acquisition.stop('official')
    complete({ is_live: true, formats: [] })
    expect((await operation).ok).toBe(false)
    expect(h.buffer.start).not.toHaveBeenCalled()
  })

  it('waits for the new buffer rather than a replayed ready state from the old producer', async () => {
    const h = harness()
    let started = false
    h.buffer.start.mockImplementationOnce(async (_role, prepare) => {
      await prepare(); started = true
      return { url: 'app://app/buffer/new/index.m3u8' }
    })
    let finished = false
    const operation = h.acquisition.resolve('https://8.8.8.8/live.flv', 'direct', 'official').then((value) => { finished = true; return value })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(finished).toBe(false)
    h.emit({ role: 'official', state: 'ready', seconds: 6 })
    expect((await operation).ok).toBe(true)
  })

  it('keeps the previous producer reconnectable when a replacement fails resolution', async () => {
    const h = harness()
    await h.acquisition.resolve('https://www.youtube.com/watch?v=abcdefghijk', 'youtube', 'official')
    h.runYtDlp.mockRejectedValueOnce(new Error('upstream failed'))
    expect((await h.acquisition.resolve('https://www.youtube.com/watch?v=klmnopqrstu', 'youtube', 'official')).ok).toBe(false)
    expect((await h.reconnect()).url).toContain('/live.m3u8')
  })

  it('validates login, quality and role arguments at the same main IPC boundary', async () => {
    const h = harness()
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition: h.acquisition })
    for (const [method, args] of [
      ['login', { platform: 'youtube', Cookie: 'PRIVATE' }], ['logout', { platform: '../../x' }],
      ['loginStatus', {}], ['switchQuality', { role: 'other', quality: '0' }],
      ['stopBuffer', { role: 'all' }], ['resolve', { input: 'x', role: '../official' }],
    ]) expect(await service.invoke(method, args)).toMatchObject({ ok: false, code: 'invalid-arguments' })
    expect(h.logins.login).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keeps existing safety and unsupported-input IPC contracts without requiring installed tools', async () => {
    const h = harness()
    const ensureTools = vi.fn(async () => { throw new Error('Tools must not be looked up') })
    const acquisition = new Acquisition({ buffer: h.buffer, logins: h.logins, runYtDlp: h.runYtDlp,
      proxy: h.proxy, dns: async () => ['8.8.8.8'], ensureTools })
    const service = createDesktopService({ dataDir: '.', proxy: h.proxy, registerMedia: () => '', acquisition })
    expect(await service.invoke('resolve', { input: 'not-a-stream-at-all' })).toMatchObject({ ok: true, value: { ok: false, failure: { code: 'unsupported-url' } } })
    expect(await service.invoke('resolve', { input: 'http://127.0.0.1:9/secret', platform: 'direct' })).toMatchObject({ ok: false, code: 'bad-port' })
    expect(ensureTools).not.toHaveBeenCalled()
    service.dispose()
  })
})
