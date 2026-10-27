import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBackendRuntime, type BackendRuntimeOptions } from './backendRuntime'
import { DanmakuFeatures } from './danmakuFeatures'
import { ActivityPreferencesStore } from './activityPreferences'
import { DanmakuRelay } from '../server/danmaku/relay'
import type { ChatMessage, DanmakuClientEvents } from '../server/danmaku/types'
import { DouyuInsightsService } from '../server/douyu/insightsService'
import { DouyuGiftPurchaseGateway } from '../server/douyu/giftPurchaseGateway'
import { resolveConfig } from '../server/config'

const message: ChatMessage = {
  platform: 'huya', room: '660002', id: 'fixture-huya', text: 'hello', username: 'fixture', color: 0,
  level: 0, receivedAt: 1000, system: false, sender: { uid: '123' },
}

describe('Huya cannot enter Douyu-only features', () => {
  it('blocks relay messages, gifts, signals and states before features, insights or catalog requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fy1sync-h2-'))
    const clients = new Map<string, DanmakuClientEvents>()
    const relay = new DanmakuRelay({ createClient: (platform, room, events) => {
      clients.set(`${platform}:${room}`, events)
      return { state: 'idle', connect() {}, close() {} }
    } })
    const danmaku = new DanmakuFeatures({ load: () => undefined, save() {} })
    const featureObserve = vi.spyOn(danmaku, 'observe')
    const insightsObserve = vi.spyOn(DouyuInsightsService.prototype, 'observe')
    const signal = vi.spyOn(DouyuInsightsService.prototype, 'signal')
    const connection = vi.spyOn(DouyuInsightsService.prototype, 'connection')
    const catalog = vi.spyOn(DouyuGiftPurchaseGateway.prototype, 'readCatalog').mockRejectedValue(new Error('offline fixture'))
    const options = {
      userDataDir: root, proxy: resolveConfig({}).proxy, relay, danmaku,
      acquisition: { subscribe: () => () => {}, describe: () => null },
      resolveRoom: async (room: string) => ({ ok: true, identity: { room, inputRoom: room } }),
      activityPreferences: new ActivityPreferencesStore({ load: () => undefined, save() {} }),
      createPipWindow: vi.fn(), chooseCaptureDestination: async () => null, validatePng: () => false,
      ffmpegPath: async () => '', openExternal: async () => {}, notifyLive() {},
    } as unknown as BackendRuntimeOptions
    const runtime = createBackendRuntime(options)
    try {
      relay.subscribe('huya:660002', { write() {}, close() {} })
      const huya = clients.get('huya:660002')!
      huya.onObservedMessage?.(message)
      huya.onObservedMessage?.({ ...message, system: true, huyaGift: { id: '1', count: 2 }, gift: { kind: 'gift', id: '1', count: 2 } })
      huya.onSignal?.({ platform: 'huya', kind: 'viewers', room: '660002', receivedAt: 1000, count: 10 })
      huya.onState('connected')
      runtime.observeFixture(message)
      expect(featureObserve).not.toHaveBeenCalled()
      expect(insightsObserve).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      expect(connection).not.toHaveBeenCalled()
      expect(catalog).not.toHaveBeenCalled()

      relay.subscribe('660002', { write() {}, close() {} })
      const douyu = clients.get('douyu:660002')!
      douyu.onObservedMessage?.({ ...message, platform: 'douyu' })
      douyu.onSignal?.({ kind: 'nobles', room: '660002', count: 1, receivedAt: 1000 })
      douyu.onState('connected')
      expect(featureObserve).toHaveBeenCalledOnce()
      expect(insightsObserve).toHaveBeenCalledOnce()
      expect(signal).toHaveBeenCalledOnce()
      expect(connection).toHaveBeenCalledOnce()
      expect(catalog).toHaveBeenCalledExactlyOnceWith('660002', expect.any(AbortSignal))
    } finally {
      relay.closeAll()
      await runtime.dispose()
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects Huya even with a numeric room and forged Douyu sender/gift metadata', () => {
    const features = new DanmakuFeatures({ load: () => undefined, save() {} })
    const history = vi.spyOn(features.history, 'observe')
    const deliveries = vi.spyOn(features.deliveries, 'observe')
    expect(features.observe(message)).toBe(false)
    expect(features.observe({ ...message, platform: undefined, room: 'huya:660002' })).toBe(false)
    expect(history).not.toHaveBeenCalled()
    expect(deliveries).not.toHaveBeenCalled()
    expect(features.history.observe(message)).toBe(false)
    expect(features.deliveries.observe(message)).toBeNull()
    const insights = new DouyuInsightsService({ gateway: {} as never })
    insights.observe(message)
    expect(insights.snapshot('660002').uniqueChatters).toBe(0)
    insights.dispose()
    vi.restoreAllMocks()
  })
})
