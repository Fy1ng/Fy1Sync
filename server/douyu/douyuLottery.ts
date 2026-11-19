import { hostAllowed, type ProxyConfig } from '../config'
import { safeFetch, type Resolver } from '../safeFetch'
import { validDouyuRoom } from '../platforms/douyuRoom'
import { readRewardJson, rewardId } from './rewardProtocol'
import { abortable, cancelBody } from './actionHttp'
import { addDouyuLotteryCost, parseDouyuLottery } from './douyuLotteryProtocol'
import { DOUYU_LOTTERY_POLL_MS, type DouyuLotterySnapshot } from './douyuLotteryTypes'
import type { DouyuGiftPurchaseGateway } from './giftPurchaseGateway'

export { DOUYU_LOTTERY_POLL_MS } from './douyuLotteryTypes'

export class DouyuLotteryError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'cancelled' | 'not-available') { super(code) }
}

export class DouyuLotteryReader {
  constructor(private readonly deps: { proxy: ProxyConfig; fetchImpl?: typeof fetch; resolve?: Resolver;
    readCatalog?: DouyuGiftPurchaseGateway['readCatalog'] }) {}

  private async request(url: string, signal: AbortSignal): Promise<{ payload: unknown; serverNow: number | null; sampledAt: number }> {
    const host = new URL(url).hostname
    if (!this.deps.proxy.enabled || !hostAllowed(host, this.deps.proxy.hosts)) throw new Error('Lottery metadata disabled')
    const { response } = await safeFetch(url, { ...this.deps.proxy, hosts: [host], maxRedirects: 0, allowNonStandardPorts: false }, {
      method: 'GET', signal, resolve: this.deps.resolve, fetchImpl: this.deps.fetchImpl,
      headers: { Accept: 'application/json', Referer: 'https://www.douyu.com/', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    })
    const date = response.headers.get('Date')
    const age = response.headers.get('Age')
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)
      || (age !== null && (!/^\d+$/.test(age) || Number(age) > DOUYU_LOTTERY_POLL_MS / 1000))) {
      cancelBody(response)
      throw new Error('Lottery metadata unavailable')
    }
    const sampledAt = performance.now()
    const serverNow = date ? Date.parse(date) + Number(age ?? 0) * 1000 : NaN
    return { payload: await readRewardJson(response, signal), serverNow: Number.isFinite(serverNow) ? serverNow : null, sampledAt }
  }

  async read(room: string, signal: AbortSignal): Promise<DouyuLotterySnapshot> {
    if (!validDouyuRoom(room)) throw new DouyuLotteryError('invalid-arguments')
    const active = AbortSignal.any([signal, AbortSignal.timeout(Math.min(15_000, Math.max(1, this.deps.proxy.requestTimeoutMs)))])
    const response = await abortable(this.request(`https://www.douyu.com/member/lottery/activity_info?room_id=${room}`, active), active)
    const { serverNow, sampledAt } = response
    if (serverNow === null) throw new Error('Official lottery time unavailable')
    let activity = parseDouyuLottery(response.payload, room, serverNow + Math.max(0, performance.now() - sampledAt))
    if (activity?.gift?.id && activity.gift.count && this.deps.readCatalog) {
      try {
        const catalog = await abortable(this.deps.readCatalog(room, active), active)
        activity = addDouyuLotteryCost(activity, catalog)
      } catch {
        if (signal.aborted) throw new DouyuLotteryError('cancelled')
      }
    }
    const currentServerTime = serverNow + Math.max(0, performance.now() - sampledAt)
    if (activity && activity.endsAt <= currentServerTime) activity = null
    return { room, serverNow: currentServerTime, status: activity ? 'active' : 'empty', activity }
  }
}

export class DouyuLotteryService {
  private room: string | null = null
  private connected = false
  private disposed = false
  private controller: AbortController | null = null
  private pending: Promise<DouyuLotterySnapshot> | null = null
  private cache: DouyuLotterySnapshot | null = null
  private checked = -Infinity

  constructor(private readonly reader: Pick<DouyuLotteryReader, 'read'>, private readonly monotonic = () => performance.now()) {}

  setRoom(room: string | null): void {
    if (room !== null && !validDouyuRoom(room)) throw new DouyuLotteryError('invalid-arguments')
    if (this.disposed || room === this.room) return
    this.clear()
    this.room = room
    this.connected = false
  }

  connection(room: string, connected: boolean): void {
    if (this.disposed || room !== this.room || this.connected === connected) return
    this.clear()
    this.connected = connected
  }

  private clear(): void {
    this.controller?.abort()
    this.controller = null
    this.pending = null
    this.cache = null
    this.checked = -Infinity
  }

  private snapshot(): DouyuLotterySnapshot {
    const value = this.cache!
    const serverNow = value.serverNow === null ? null : value.serverNow + Math.max(0, this.monotonic() - this.checked)
    const activity = value.activity && serverNow !== null && value.activity.endsAt > serverNow ? value.activity : null
    return structuredClone({ ...value, serverNow, activity, status: value.status === 'unavailable' ? 'unavailable' : activity ? 'active' : 'empty' })
  }

  async read(room: string): Promise<DouyuLotterySnapshot> {
    if (!validDouyuRoom(room)) throw new DouyuLotteryError('invalid-arguments')
    if (room !== this.room || !this.connected) throw new DouyuLotteryError('cancelled')
    if (this.pending) return structuredClone(await this.pending)
    if (this.cache && this.monotonic() - this.checked < DOUYU_LOTTERY_POLL_MS) return this.snapshot()
    const controller = new AbortController()
    this.controller = controller
    const request = (async () => {
      let value: DouyuLotterySnapshot
      try { value = await abortable(Promise.resolve().then(() => this.reader.read(room, controller.signal)), controller.signal) }
      catch { value = { room, serverNow: null, status: 'unavailable', activity: null } }
      if (controller.signal.aborted) throw new DouyuLotteryError('cancelled')
      this.cache = value
      this.checked = this.monotonic()
      return this.snapshot()
    })()
    this.pending = request
    try { return await request }
    finally {
      if (this.pending === request) {
        this.pending = null
        this.controller = null
      }
    }
  }

  officialUrl(room: string, activityId: string): string {
    if (!validDouyuRoom(room) || !rewardId(activityId)) throw new DouyuLotteryError('invalid-arguments')
    if (room !== this.room || !this.connected) throw new DouyuLotteryError('cancelled')
    const activity = this.cache && this.monotonic() - this.checked < DOUYU_LOTTERY_POLL_MS ? this.snapshot().activity : null
    if (!activity || activity.id !== activityId) throw new DouyuLotteryError('not-available')
    return `https://www.douyu.com/${room}`
  }

  dispose(): void {
    this.clear()
    this.disposed = true
    this.room = null
    this.connected = false
  }
}
