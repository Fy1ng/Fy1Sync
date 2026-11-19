import { FeatureApiError, type FeatureApi } from '../server/featureApi'
import type { DanmakuRelay } from '../server/danmaku/relay'
import type { ResolvedStream } from '../server/platforms/types'
import { readBilibiliRoomIdentity, type BilibiliCookieHeader } from '../server/platforms/bilibiliWeb'
import { readBilibiliEmoteCatalog } from '../server/platforms/bilibiliEmotes'
import { bilibiliWatchEvidenceStatus } from '../server/platforms/bilibiliRoomInsights'
import { BilibiliLotteryGateway, bilibiliLotteryOfficialUrl } from '../server/platforms/bilibiliLottery'
import { BilibiliLotteryService } from './bilibiliLottery'
import { readDouyinLottery, douyinLotteryOfficialUrl } from '../server/douyin/douyinLotteryReader'
import type { ProxyConfig } from '../server/config'
import type { NetworkContext } from '../server/networkPolicy'
import { huyaOnTvOfficialUrl } from '../server/platforms/huyaOnTv'
import { DOUYIN_LOTTERY_POLL_MS, douyinLotteryId, douyinLotteryRemaining, type DouyinLotterySnapshot } from '../src/core/douyinLottery'
import { buildYouTubeWatchEvidence } from '../src/core/youtubeWatchEvidence'
import { createTwitchProgressSnapshot } from '../src/core/twitchProgress'
import type { SourceRole } from '../src/core/types'

interface PlatformRoomOptions {
  api: FeatureApi
  relay: DanmakuRelay
  proxy: ProxyConfig
  source: (role: SourceRole) => ResolvedStream | null
  openExternal: (url: string) => Promise<unknown>
  network: (platform: 'bilibili' | 'douyin') => NetworkContext
  bilibiliCookieHeader: BilibiliCookieHeader
  bilibiliAccount: () => Promise<string | null>
  enabled: boolean
}

export function registerPlatformRoomFeatures(options: PlatformRoomOptions) {
  const { relay, api } = options
  const gateway = new BilibiliLotteryGateway({
    proxy: options.proxy, network: () => options.network('bilibili'), cookieHeader: options.bilibiliCookieHeader,
  })
  const lottery = new BilibiliLotteryService({
    read: (room, signal) => options.enabled ? gateway.read(room, signal) : Promise.reject(new FeatureApiError('not-available')),
    openExternal: options.openExternal,
  })
  let selected: string | null = null
  let selectedLifetime = new AbortController()
  let bilibiliLoginLifetime = new AbortController()
  let douyinFlight: Promise<DouyinLotterySnapshot | null> | null = null
  let douyinSnapshot: DouyinLotterySnapshot | null = null

  const current = (room: unknown, pattern: RegExp): string => {
    if (typeof room !== 'string' || !pattern.test(room)) throw new FeatureApiError('invalid-arguments')
    if (room !== selected) throw new FeatureApiError('room-changed')
    return room
  }
  const bilibiliRoom = (room: unknown) => current(room, /^bilibili:[1-9]\d{0,11}$/)
  const douyinRoom = (room: unknown) => current(room, /^douyin:[1-9]\d{0,19}$/)
  const sourceRoom = (role: unknown, platform: string) => {
    if (role !== 'official' && role !== 'commentary') throw new FeatureApiError('invalid-arguments')
    const source = options.source(role)
    if (!source || source.platform !== platform) throw new FeatureApiError('room-changed')
    return source
  }
  const resetDouyin = () => { douyinFlight = null; douyinSnapshot = null }
  const releaseRelay = relay.observe(event => {
    if (event.type === 'state' && event.room === selected && event.platform === 'douyin' && event.state !== 'connected') resetDouyin()
  })
  const lotteryHandlers = lottery.handlers()
  api.register({
    ...lotteryHandlers,
    readBilibiliLottery: async (args, context) => {
      const source = sourceRoom(args.slot, 'bilibili')
      if (source.sourceRoom !== args.input) throw new FeatureApiError('room-changed')
      const result = await lotteryHandlers.readBilibiliLottery(args, context)
      if (sourceRoom(args.slot, 'bilibili').sourceRoom !== args.input || (result.room && result.room !== args.input)) throw new FeatureApiError('room-changed')
      return result
    },
    openBilibiliLotteryRoom: (args, context) => {
      if (sourceRoom(args.slot, 'bilibili').sourceRoom !== args.room) throw new FeatureApiError('room-changed')
      return lotteryHandlers.openBilibiliLotteryRoom(args, context)
    },
    getBilibiliRoomInsights: ({ room }) => relay.bilibiliRoomInsights(bilibiliRoom(room)),
    openBilibiliRoomInfo: async ({ room }) => {
      const target = bilibiliRoom(room)
      await options.openExternal(bilibiliLotteryOfficialUrl(target.slice(9)))
      return { opened: true }
    },
    getBilibiliWatchEvidence: async ({ room }) => {
      const target = bilibiliRoom(room).slice(9)
      if (!options.enabled) throw new FeatureApiError('not-available')
      const signal = AbortSignal.any([selectedLifetime.signal, bilibiliLoginLifetime.signal])
      const [identity, account] = await Promise.all([readBilibiliRoomIdentity(target, signal), options.bilibiliAccount()])
      signal.throwIfAborted()
      if (identity.room !== target) throw new FeatureApiError('room-changed')
      return bilibiliWatchEvidenceStatus(identity, account, Date.now())
    },
    getBilibiliEmoteCatalog: async ({ room }) => {
      const target = bilibiliRoom(room).slice(9)
      if (!options.enabled) throw new FeatureApiError('not-available')
      const signal = AbortSignal.any([selectedLifetime.signal, bilibiliLoginLifetime.signal])
      const account = await options.bilibiliAccount()
      signal.throwIfAborted()
      if (!account) throw new FeatureApiError('login-required')
      const result = await readBilibiliEmoteCatalog(target, account, options.bilibiliCookieHeader, signal)
      signal.throwIfAborted()
      return result
    },
    getDouyinLottery: ({ room }) => {
      const target = douyinRoom(room)
      const client = relay.activeDouyinClient(target)
      if (!client || !options.enabled) return null
      if (douyinFlight) return douyinFlight
      const signal = selectedLifetime.signal
      const work = client.readLottery((metadata, readSignal) =>
        readDouyinLottery(metadata, readSignal, { proxy: options.proxy, network: options.network('douyin') }), signal)
        .then(snapshot => {
          if (signal.aborted || douyinFlight !== work || client !== relay.activeDouyinClient(target)) return null
          return douyinSnapshot = snapshot
        }).finally(() => { if (douyinFlight === work) douyinFlight = null })
      return douyinFlight = work
    },
    openDouyinLotteryRoom: async ({ room, roomId, activityId }) => {
      const target = douyinRoom(room)
      if (!douyinLotteryId(roomId) || !douyinLotteryId(activityId)) throw new FeatureApiError('invalid-arguments')
      const client = relay.activeDouyinClient(target)
      const snapshot = douyinSnapshot
      const age = Date.now() - (snapshot?.observedAt ?? 0)
      if (snapshot?.status !== 'active' || snapshot.room !== target || snapshot.roomId !== roomId
        || snapshot.activity.id !== activityId || age < 0 || age >= DOUYIN_LOTTERY_POLL_MS
        || !douyinLotteryRemaining(snapshot.activity, age) || !client) throw new FeatureApiError('not-available')
      const signal = selectedLifetime.signal
      const matched = await client.readLottery(async metadata => {
        if (metadata.roomId !== roomId) throw new FeatureApiError('room-changed')
        return snapshot
      }, signal)
      if (!matched || signal.aborted || snapshot !== douyinSnapshot || client !== relay.activeDouyinClient(target)) throw new FeatureApiError('room-changed')
      await options.openExternal(douyinLotteryOfficialUrl(target))
      return { opened: true }
    },
    openHuyaOnTvRoom: async ({ room }) => {
      const target = current(room, /^huya:[1-9]\d{0,15}$/)
      await options.openExternal(huyaOnTvOfficialUrl(target))
      return { opened: true }
    },
    openPlatformRoomInfo: async ({ role, entry }) => {
      let url: string | null = null
      if (entry === 'history' || entry === 'time-watched') {
        const source = sourceRoom(role, 'youtube')
        const { officialEntries } = buildYouTubeWatchEvidence({ authorized: false, accountRef: null, videoId: source.channel })
        url = entry === 'history' ? officialEntries.watchHistory : officialEntries.timeWatched
      } else if (entry === 'channel' || entry === 'drops') {
        const source = sourceRoom(role, 'twitch')
        const { officialLinks } = createTwitchProgressSnapshot({ channelLogin: source.channel })
        url = entry === 'channel' ? officialLinks.channel : officialLinks.inventory
      }
      if (!url) throw new FeatureApiError('not-available')
      await options.openExternal(url)
      return { opened: true }
    },
  })
  return {
    select(room: string | null) {
      if (room === selected) return
      selectedLifetime.abort()
      selectedLifetime = new AbortController()
      selected = room
      resetDouyin()
    },
    invalidateBilibili() {
      bilibiliLoginLifetime.abort()
      bilibiliLoginLifetime = new AbortController()
      lottery.invalidate()
      api.publish({ topic: 'bilibili-lottery-invalidated', data: {} })
    },
    sourceChanged() {
      lottery.invalidate()
      api.publish({ topic: 'bilibili-lottery-invalidated', data: {} })
    },
    releaseSender: (id: number) => lottery.releaseSender(id),
    dispose() {
      selectedLifetime.abort()
      bilibiliLoginLifetime.abort()
      releaseRelay()
      lottery.dispose()
    },
  }
}
