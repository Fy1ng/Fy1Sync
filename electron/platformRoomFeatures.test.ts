import { expect, it, vi } from 'vitest'
import { FeatureApi } from '../server/featureApi'
import { DanmakuRelay } from '../server/danmaku/relay'
import { networkContext } from '../server/networkPolicy'
import type { ResolvedStream } from '../server/platforms/types'
import { registerPlatformRoomFeatures } from './platformRoomFeatures'

it('scopes room data and only opens the official links for the selected source', async () => {
  const api = new FeatureApi()
  const relay = new DanmakuRelay()
  const openExternal = vi.fn(async () => {})
  const readAccount = vi.fn(async () => null)
  const source: ResolvedStream = { platform: 'youtube', url: '/test-sources/official.mp4', kind: 'progressive',
    label: 'fixture', channel: 'abcdefghijk', requiresProxy: false }
  const features = registerPlatformRoomFeatures({
    api, relay, source: role => role === 'official' ? source : null, openExternal, network: networkContext,
    enabled: false, bilibiliAccount: readAccount, bilibiliCookieHeader: async () => '',
    proxy: { enabled: false, hosts: [], allowNonStandardPorts: false, maxRedirects: 0, requestTimeoutMs: 1000 },
  })
  const invoke = (method: string, args: unknown) => api.invoke(method, args, { senderId: 1 })
  try {
    features.select('bilibili:21452505')
    expect(await invoke('getBilibiliRoomInsights', { room: 'bilibili:21452505' })).toMatchObject({ ok: true, value: { room: 'bilibili:21452505' } })
    expect(await invoke('getBilibiliWatchEvidence', { room: 'bilibili:21452505' })).toMatchObject({ ok: false, code: 'not-available' })
    expect(readAccount).not.toHaveBeenCalled()
    expect(await invoke('openBilibiliRoomInfo', { room: 'bilibili:123' })).toMatchObject({ ok: false, code: 'room-changed' })
    expect(await invoke('readBilibiliLottery', { slot: 'official', watchId: 'watch-1', input: '21452505', reminders: false }))
      .toMatchObject({ ok: false, code: 'room-changed' })

    features.select('huya:660000')
    expect(await invoke('getBilibiliRoomInsights', { room: 'bilibili:21452505' })).toMatchObject({ ok: false, code: 'room-changed' })
    expect(await invoke('openHuyaOnTvRoom', { room: 'huya:660000' })).toMatchObject({ ok: true })
    expect(await invoke('openPlatformRoomInfo', { role: 'official', entry: 'drops' })).toMatchObject({ ok: false, code: 'room-changed' })
    expect(await invoke('openPlatformRoomInfo', { role: 'official', entry: 'history' })).toMatchObject({ ok: true })
    source.platform = 'twitch'
    source.channel = 'fixture_channel'
    expect(await invoke('openPlatformRoomInfo', { role: 'official', entry: 'channel' })).toMatchObject({ ok: true })
    expect(openExternal.mock.calls).toEqual([
      ['https://www.huya.com/660000'], ['https://myactivity.google.com/product/youtube'], ['https://www.twitch.tv/fixture_channel'],
    ])
  } finally { features.dispose(); relay.closeAll(); api.dispose() }
})
