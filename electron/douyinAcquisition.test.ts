import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../server/config'
import { syntheticDouyinPage, syntheticDouyinRoom } from '../server/platforms/fixtures/douyinFixture'
import { Acquisition } from './acquisition'
import type { BufferInput, BufferState } from './bufferManager'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }))
afterEach(() => vi.restoreAllMocks())

describe('Douyin acquisition and refreshed playback inputs', () => {
  it('refreshes metadata on reconnect and quality changes while exposing only local playback', async () => {
    type Dependencies = ConstructorParameters<typeof Acquisition>[0]
    const listeners = new Set<(value: BufferState) => void>()
    const inputs: BufferInput[] = []
    let prepare: (() => Promise<BufferInput>) | undefined
    let revision = 0
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      expect(String(input)).toBe('https://live.douyin.com/100')
      const room = syntheticDouyinRoom()
      room.stream_url.live_core_sdk_data.pull_data.stream_data = room.stream_url.live_core_sdk_data.pull_data.stream_data.replaceAll('SYNTHETIC_', `SYNTHETIC_${++revision}_`)
      return new Response(syntheticDouyinPage(room), { headers: { 'set-cookie': 'ttwid=ANONYMOUS_FIXTURE; Path=/' } })
    })
    const mediaInput = vi.fn<NonNullable<Dependencies['mediaInput']>>(async () => ({ url: 'http://127.0.0.1:19000/media/fixture', proxyUrl: '' }))
    const runYtDlp = vi.fn<Dependencies['runYtDlp']>()
    const cookieHeader = vi.fn(async (platform: 'douyu' | 'douyin', url?: string) => {
      expect(platform).toBe('douyin')
      expect(url).toBe('https://live.douyin.com/100')
      return 'sessionid=LOGGED_IN_FIXTURE'
    })
    const acquisition = new Acquisition({ proxy: resolveConfig({}).proxy, fetchImpl, mediaInput, runYtDlp,
      logins: { cookieHeader, login: vi.fn(), logout: vi.fn(), loginStatus: vi.fn() },
      buffer: {
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        start: vi.fn(async (role, resolve) => {
          prepare = resolve
          inputs.push(await resolve())
          for (const listener of listeners) listener({ role, state: 'ready', seconds: 4, hasVideo: true, completeSegments: 1 })
          return { url: `app://app/buffer/fixture/${role}/generation-${revision}/index.m3u8` }
        }),
        stop: vi.fn(async () => {}),
      },
    })
    try {
      const initial = await acquisition.resolve('https://live.douyin.com/100', 'douyin', 'commentary')
      expect(initial).toMatchObject({ ok: true, stream: { platform: 'douyin', kind: 'hls', quality: 'origin',
        url: 'app://app/buffer/fixture/commentary/generation-1/index.m3u8' } })
      const reconnected = await prepare!()
      expect(reconnected.url).toBe('http://127.0.0.1:19000/media/fixture')
      const lower = await acquisition.switchQuality('commentary', 'sd')
      expect(lower).toMatchObject({ ok: true, stream: { quality: 'sd' } })
      expect(mediaInput.mock.calls.map(call => call[0])).toEqual([
        'https://media.douyincdn.com/fixture-high.flv?sign=SYNTHETIC_1_HIGH',
        'https://media.douyincdn.com/fixture-high.flv?sign=SYNTHETIC_2_HIGH',
        'https://media.douyincdn.com/fixture-low.flv?sign=SYNTHETIC_3_LOW',
      ])
      for (const call of mediaInput.mock.calls) {
        expect(call[1]).toMatchObject({ Referer: 'https://live.douyin.com/' })
        expect(call[1]).not.toHaveProperty('Cookie')
      }
      expect(JSON.stringify([initial, lower, acquisition.describe('commentary')])).not.toMatch(/SYNTHETIC_|ANONYMOUS_FIXTURE|LOGGED_IN_FIXTURE|media\.douyincdn|Cookie|User-Agent/)
      expect(cookieHeader).toHaveBeenCalledTimes(3)
      expect(runYtDlp).not.toHaveBeenCalled()
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    } finally { acquisition.dispose() }
  })
})
