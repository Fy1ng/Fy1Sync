import { decodeHuyaOnTvPanel, type HuyaOnTvSnapshot } from '../platforms/huyaOnTv'
import type { HuyaDanmakuRoom } from '../platforms/huyaDanmaku'
import type { DanmakuClientDeps } from './types'

export interface HuyaOnTvClientDeps extends DanmakuClientDeps {
  readPanel: (room: HuyaDanmakuRoom, signal: AbortSignal) => Promise<Uint8Array>
}
/** One anonymous polling loop per shared room, independent of media clocks. */
export class HuyaOnTvClient {
  private identity: HuyaDanmakuRoom | null = null
  private connected = false
  private request: AbortController | null = null
  private timer: unknown = null
  private generation = 0
  private snapshot: HuyaOnTvSnapshot | null = null
  constructor(private room: string, private publish: (snapshot: HuyaOnTvSnapshot) => void, private deps: HuyaOnTvClientDeps) {}
  setIdentity(identity: HuyaDanmakuRoom): void {
    if (identity.room !== this.room) return
    if (this.identity?.presenterUid === identity.presenterUid
      && this.identity.topSid === identity.topSid && this.identity.subSid === identity.subSid) return
    this.cancel()
    this.identity = identity
    this.snapshot = null
    if (this.connected) this.refresh()
  }
  setConnected(connected: boolean): void {
    if (connected === this.connected) return
    this.connected = connected
    this.cancel()
    if (connected) {
      this.snapshot = null
      this.refresh()
    }
    else this.emit('unavailable')
  }
  close(): void { this.connected = false; this.cancel(); this.identity = null; this.snapshot = null }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private cancel(): void {
    this.generation++
    this.request?.abort(); this.request = null
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
  }
  private emit(status: HuyaOnTvSnapshot['status']): void {
    this.snapshot = { room: `huya:${this.room}`, status, activity: null, observedAt: this.now() }
    this.publish(this.snapshot)
  }
  private refresh(): void {
    if (!this.identity || !this.connected || this.request) return
    const controller = new AbortController(), generation = this.generation, identity = this.identity
    this.request = controller
    if (!this.snapshot) this.emit('loading')
    if (!controller.signal.aborted) void this.poll(identity, controller, generation)
  }

  private async poll(identity: HuyaDanmakuRoom, controller: AbortController, generation: number): Promise<void> {
    const current = () => generation === this.generation && this.connected && !controller.signal.aborted
    try {
      const bytes = await this.deps.readPanel(identity, controller.signal)
      if (!current()) return
      const snapshot = decodeHuyaOnTvPanel(bytes, identity, this.now())
      const before = this.snapshot?.activity
      const after = snapshot.activity
      if (this.snapshot?.status === 'active' && snapshot.status === 'active' && before && after
        && before.id === after.id && before.endsAt === after.endsAt && after.serverNow <= before.serverNow) return
      this.snapshot = snapshot
      this.publish(snapshot)
    } catch {
      if (current()) this.emit('unavailable')
    } finally {
      if (current()) {
        this.request = null
        this.timer = (this.deps.setTimer ?? setTimeout)(() => {
          this.timer = null
          this.refresh()
        }, 15_000)
      }
    }
  }
}
