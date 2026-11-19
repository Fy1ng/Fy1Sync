import { BILIBILI_LOTTERY_FRESH_MS, bilibiliLotteryServerTime, type BilibiliLotteryHandlers,
  type BilibiliLotteryMethods, type BilibiliLotterySnapshot, type BilibiliLotteryWatch } from '../src/core/bilibiliLottery'
import { bilibiliLotteryEmpty, bilibiliLotteryOfficialUrl, bilibiliLotteryRoom } from '../server/platforms/bilibiliLottery'
import { FeatureApiError } from '../server/featureApi'
import type { FeatureCallContext } from './featureContracts'

type Watch = { id: string; input: string; snapshot: BilibiliLotterySnapshot; controller: AbortController;
  pending?: Promise<BilibiliLotterySnapshot>; lastRead: number; touched: number; reminders: boolean }
export interface BilibiliLotteryDeps {
  read: (input: string, signal: AbortSignal) => Promise<BilibiliLotterySnapshot>
  openExternal: (url: string) => Promise<unknown>
  notify?: (room: string, prize: string) => void
  now?: () => number
}

function abortable<Value>(signal: AbortSignal, run: () => Promise<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new FeatureApiError('cancelled')) }
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return run() }).then(value => {
      signal.throwIfAborted(); resolve(value)
    }, reject).catch(reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function validateFields(args: unknown, names: readonly string[]): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args) as object | null)
    || Reflect.ownKeys(args).some(key => typeof key !== 'string' || !names.includes(key)
      || !('value' in Object.getOwnPropertyDescriptor(args, key)!))) throw new FeatureApiError('invalid-arguments')
}

export class BilibiliLotteryService {
  private readonly watches = new Map<string, Watch>()
  private readonly retired = new Set<string>()
  private readonly reminded = new Set<string>()
  private readonly now: () => number
  private disposed = false
  private readonly timer: ReturnType<typeof setInterval>
  constructor(private readonly deps: BilibiliLotteryDeps) {
    this.now = deps.now ?? Date.now
    this.timer = setInterval(() => this.expire(), 15_000)
    this.timer.unref?.()
  }
  private key(args: BilibiliLotteryWatch, context: FeatureCallContext): string {
    if (!Number.isSafeInteger(context?.senderId) || !context.senderId || context.senderId < 1) throw new FeatureApiError('forbidden')
    if (!args || (args.slot !== 'official' && args.slot !== 'commentary') || typeof args.watchId !== 'string'
      || !/^[a-zA-Z0-9-]{1,64}$/.test(args.watchId)) throw new FeatureApiError('invalid-arguments')
    if (this.disposed) throw new FeatureApiError('service-closed')
    return `${context.senderId}:${args.slot}`
  }
  private markRetired(key: string, id: string): void {
    this.retired.add(`${key}:${id}`)
    if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value!)
  }
  private retire(key: string, watch: Watch): void {
    watch.controller.abort()
    this.watches.delete(key)
    this.markRetired(key, watch.id)
  }
  private expire(): void {
    for (const [key, watch] of this.watches) if (this.now() - watch.touched > BILIBILI_LOTTERY_FRESH_MS) this.retire(key, watch)
  }
  releaseSender(id: number): void {
    for (const [key, watch] of this.watches) if (key.startsWith(`${id}:`)) this.retire(key, watch)
  }
  invalidate(): void { for (const [key, watch] of this.watches) this.retire(key, watch) }
  dispose(): void { this.invalidate(); this.disposed = true; clearInterval(this.timer) }

  async read(args: BilibiliLotteryMethods['readBilibiliLottery']['args'], context: FeatureCallContext): Promise<BilibiliLotterySnapshot> {
    validateFields(args, ['slot', 'watchId', 'input', 'reminders'])
    const key = this.key(args, context)
    if (typeof args.reminders !== 'boolean' || !bilibiliLotteryRoom(args.input)) throw new FeatureApiError('invalid-arguments')
    this.expire()
    if (this.retired.has(`${key}:${args.watchId}`)) throw new FeatureApiError('cancelled')
    let watch = this.watches.get(key)
    if (watch && (watch.id !== args.watchId || watch.input !== args.input)) {
      this.retire(key, watch)
      if (watch.id === args.watchId) throw new FeatureApiError('cancelled')
    }
    watch = this.watches.get(key)
    if (!watch) {
      if (this.watches.size >= 16) throw new FeatureApiError('busy')
      watch = { id: args.watchId, input: args.input, snapshot: bilibiliLotteryEmpty(null, this.now(), 'unverified'),
        controller: new AbortController(), lastRead: -Infinity, touched: this.now(), reminders: args.reminders }
      this.watches.set(key, watch)
    }
    watch.touched = this.now()
    const entry = watch
    if (!entry.pending && this.now() - entry.lastRead >= 5_000) {
      entry.lastRead = this.now()
      const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(10_000)])
      entry.pending = abortable(signal, () => this.deps.read(args.input, signal)).then(snapshot => {
        signal.throwIfAborted()
        if (this.watches.get(key) !== entry) throw new FeatureApiError('cancelled')
        entry.snapshot = { ...snapshot, reminder: false }
        return entry.snapshot
      }).finally(() => { entry.pending = undefined })
    }
    const result = { ...await (entry.pending ?? Promise.resolve(entry.snapshot)), reminder: false }
    if (entry.controller.signal.aborted || this.watches.get(key) !== entry) throw new FeatureApiError('cancelled')
    const at = bilibiliLotteryServerTime(result, this.now())
    const remaining = result.endsAt !== null && at !== null ? result.endsAt - at : null
    const reminderKey = `${result.room}:${result.activity?.id}`
    if (entry.reminders && result.phase === 'ongoing' && remaining !== null
      && remaining > (result.clockUncertaintyMs ?? Infinity) && result.room && result.activity
      && !this.reminded.has(reminderKey) && this.reminded.size < 1024) {
      this.reminded.add(reminderKey)
      result.reminder = true
      try { this.deps.notify?.(result.room, result.activity.prize) } catch {}
    }
    if (result.phase === 'ongoing' && remaining !== null && remaining <= 0) result.phase = 'ended'
    return result
  }
  stop(args: BilibiliLotteryWatch, context: FeatureCallContext): { stopped: boolean } {
    validateFields(args, ['slot', 'watchId'])
    const key = this.key(args, context)
    const watch = this.watches.get(key)
    if (watch?.id === args.watchId) { this.retire(key, watch); return { stopped: true } }
    this.markRetired(key, args.watchId)
    return { stopped: false }
  }
  setReminders(args: BilibiliLotteryMethods['setBilibiliLotteryReminders']['args'], context: FeatureCallContext): { enabled: boolean } {
    validateFields(args, ['slot', 'watchId', 'enabled'])
    const key = this.key(args, context)
    if (typeof args.enabled !== 'boolean') throw new FeatureApiError('invalid-arguments')
    this.expire()
    const watch = this.watches.get(key)
    if (!watch || watch.id !== args.watchId) throw new FeatureApiError('cancelled')
    watch.reminders = args.enabled
    return { enabled: watch.reminders }
  }
  async open(args: BilibiliLotteryMethods['openBilibiliLotteryRoom']['args'], context: FeatureCallContext): Promise<{ opened: true }> {
    validateFields(args, ['slot', 'watchId', 'room', 'activityId'])
    const key = this.key(args, context)
    if (typeof args.room !== 'string' || !/^[1-9][0-9]{0,11}$/.test(args.room)
      || (args.activityId !== null && (typeof args.activityId !== 'string'
        || !/^[1-9][0-9]{0,15}$/.test(args.activityId)))) throw new FeatureApiError('invalid-arguments')
    this.expire()
    const watch = this.watches.get(key)
    if (!watch || watch.id !== args.watchId || watch.snapshot.room !== args.room
      || (watch.snapshot.activity?.id ?? null) !== args.activityId || this.now() < watch.snapshot.checkedAt
      || this.now() - watch.snapshot.checkedAt > BILIBILI_LOTTERY_FRESH_MS) throw new FeatureApiError('room-changed')
    await this.deps.openExternal(bilibiliLotteryOfficialUrl(args.room))
    return { opened: true }
  }
  handlers(): BilibiliLotteryHandlers<FeatureCallContext> {
    return { readBilibiliLottery: (args, context) => this.read(args, context),
      setBilibiliLotteryReminders: (args, context) => this.setReminders(args, context),
      stopBilibiliLottery: (args, context) => this.stop(args, context), openBilibiliLotteryRoom: (args, context) => this.open(args, context) }
  }
}
