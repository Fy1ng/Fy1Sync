/** IPC subscription tests keep filtering, media-time scheduling and profiles real. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MediaEngine } from '../media/mediaEngine'
import { primeMediaElement } from '../test/setup'
import { packBitmap } from '../core/bitmapCodec'
import {
  CLOCK_CHARS,
  createEmptyProfile,
  TEMPLATE_PIXELS,
  type RecognitionProfile,
} from '../core/profileSchema'
import type { MediaDescriptor } from '../core/types'
import { CHAT_HISTORY_LIMIT, Session } from './session'
import type { StreamSyncerBridge } from '../../electron/contracts'
import type { DanmakuEvent } from './apiClient'
import { SETTINGS_KEY, type SettingsStorage } from './settings'
import { parseStt, toChatMessage } from '../../server/danmaku/douyuProtocol'

/** The only fake boundary is the typed preload, including its cancellation handle. */
class StubDanmakuSubscription {
  static instances: StubDanmakuSubscription[] = []
  closed = false

  constructor(readonly room: string, private readonly listener: (event: DanmakuEvent) => void) {
    StubDanmakuSubscription.instances.push(this)
  }

  close(): void { this.closed = true }

  emit(event: string, data: unknown): void {
    // Deliberately allow late delivery: ApiClient must discard queued events on close.
    this.listener({ event, data })
  }
}

function preload(): StreamSyncerBridge {
  return {
    invoke: vi.fn(async () => ({ ok: true, value: { presets: [] } })) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: (room, listener) => {
      const subscription = new StubDanmakuSubscription(room, listener)
      return () => subscription.close()
    },
  }
}

function memoryStorage(): SettingsStorage {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
  }
}

function descriptor(): MediaDescriptor {
  return {
    kind: 'progressive',
    url: 'https://example.test/commentary.mp4',
    input: 'https://example.test/commentary.mp4',
    label: '解说直播',
    loop: false,
    viaProxy: false,
  }
}

/** A profile the schema accepts as recognition-ready: every clock char has a sample. */
function readyProfile(id = 'cs2/iem'): RecognitionProfile {
  const templates: RecognitionProfile['templates'] = {}
  CLOCK_CHARS.forEach((char, index) => {
    const mask = new Uint8Array(TEMPLATE_PIXELS)
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      mask[pixel] = (pixel + index) % 3 === 0 ? 255 : 0
    }
    templates[char] = [{ id: `${char}-0`, data: packBitmap(mask), createdAt: 1 }]
  })
  return { ...createEmptyProfile(id, 'IEM 主舞台'), templates }
}

const sessions: Session[] = []

async function makeSession(options: { commentaryTime?: number; load?: boolean } = {}): Promise<{
  session: Session
  engine: MediaEngine
}> {
  const engine = new MediaEngine()
  const session = new Session({ engine, storage: memoryStorage(), createSampler: () => null })
  sessions.push(session)
  if (options.load !== false) {
    await session.loadSource('commentary', descriptor())
    primeMediaElement(engine.element('commentary'), {
      duration: 600,
      currentTime: options.commentaryTime ?? 100,
    })
    // Playing, as the scheduling tests assume: a paused commentary releases chat at once.
    setPaused(engine.element('commentary'), false)
  }
  return { session, engine }
}

function setPaused(element: HTMLMediaElement, paused: boolean): void {
  Object.defineProperty(element, 'paused', { configurable: true, value: paused })
  element.dispatchEvent(new Event(paused ? 'pause' : 'play'))
}

beforeEach(() => {
  StubDanmakuSubscription.instances = []
  vi.stubGlobal('streamSyncer', preload())
})

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

describe('Session danmaku transport', () => {
  it('normalizes a Huya alias through state without turning the room into a Douyu room', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('huya:kpl')
    const source = StubDanmakuSubscription.instances[0]!
    expect(source.room).toBe('huya:kpl')
    source.emit('state', { state: 'connected', room: 'huya:660000' })
    expect(session.flush().danmaku).toMatchObject({ room: 'huya:660000', connected: true })
    source.emit('state', { state: 'connected', room: '288016' })
    expect(session.flush().danmaku.room).toBe('huya:660000')
    source.emit('danmaku', { platform: 'douyu', text: 'wrong platform', username: '观众' })
    expect(session.drainDanmaku()).toEqual([])
    source.emit('state', { state: 'connected', room: 'huya:1234567890123456' })
    expect(session.flush().danmaku.room).toBe('huya:1234567890123456')
  })

  it('schedules Huya chat against commentary media time and ignores Douyu sender metadata and scores', async () => {
    const { session, engine } = await makeSession({ commentaryTime: 100 })
    session.configureDanmakuProcessing({ filterSuspectedBots: true })
    session.connectDanmaku('huya:660000')
    StubDanmakuSubscription.instances[0]!.emit('danmaku', { platform: 'huya', text: '虎牙加油', username: '观众',
      sender: { uid: '42', level: 12 }, dms: 12 })
    engine.element('commentary').currentTime = 95
    expect(session.drainDanmaku()).toEqual([])
    engine.element('commentary').currentTime = 100
    const [message] = session.drainDanmaku()
    expect(message).toMatchObject({ text: '虎牙加油', user: '观众', platform: 'huya', scheduleTime: 100 })
    expect(message).not.toHaveProperty('sender')
    expect(message).not.toHaveProperty('dms')
    expect(session.chatHistory()).toEqual([message])
  })

  it('hides Huya gifts by default and uses the existing visibility and blocked-user settings', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('huya:660000')
    const source = StubDanmakuSubscription.instances[0]!
    const payload = { platform: 'huya', text: '赠送虎粮 x2', username: '观众', system: true,
      huyaGift: { id: '1', count: 2, name: '虎粮' } }
    source.emit('danmaku', payload)
    expect(session.drainDanmaku()).toEqual([])
    session.updateDanmakuSettings({ showGifts: true, density: 0.1, filter: { blockedPatterns: ['礼物'], blockedUsers: ['屏蔽观众'], maxLength: 1 } })
    source.emit('danmaku', { ...payload, username: '屏蔽观众' })
    source.emit('danmaku', { ...payload, huyaGift: { id: '1', count: -1 } })
    source.emit('danmaku', { ...payload, huyaGift: undefined })
    source.emit('danmaku', payload)
    payload.huyaGift.count = 999
    expect(session.drainDanmaku()).toEqual([expect.objectContaining({ platform: 'huya', system: true, text: '赠送虎粮 x2', huyaGift: { id: '1', count: 2, name: '虎粮' } })])
  })

  it('does not accept Huya metadata into a legacy numeric Douyu subscription', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!
    source.emit('state', { state: 'connected', room: 'huya:288016' })
    source.emit('danmaku', { platform: 'huya', text: 'wrong platform', username: '观众' })
    source.emit('danmaku', { text: 'legacy Douyu', username: '观众' })
    expect(session.flush().danmaku.room).toBe('288016')
    expect(session.drainDanmaku()).toEqual([expect.objectContaining({ text: 'legacy Douyu', platform: 'douyu' })])
  })

  it('drops gift notices unless they are switched on', async () => {
    const { session, engine } = await makeSession({ commentaryTime: 100 })
    const gift = { kind: 'prop' as const, id: '268', count: 1 }
    session.pushDanmaku({ text: '粉丝荧光棒 x 1', user: '观众', color: '#fff', gift })
    session.pushDanmaku({ text: '普通弹幕', user: '观众', color: '#fff' })
    engine.element('commentary').currentTime = 101
    expect(session.drainDanmaku().map((message) => message.text)).toEqual(['普通弹幕'])
  })

  it('retains copied gift and sender facts on the commentary timeline', async () => {
    const { session } = await makeSession({ commentaryTime: 100 })
    session.updateDanmakuSettings({ showGifts: true })
    session.connectDanmaku('288016')
    const payload = { text: '粉丝荧光棒 x 2', username: '送礼观众', color: 0, system: true,
      sender: { uid: '42', level: 12, nobleLevel: 0 }, gift: { kind: 'prop', id: '268', count: 2 } }
    StubDanmakuSubscription.instances[0]!.emit('danmaku', payload)
    payload.gift.count = 99
    payload.sender.uid = '100'
    const [message] = session.drainDanmaku()
    expect(message).toMatchObject({ text: '粉丝荧光棒 x 2', user: '送礼观众', scheduleTime: 100,
      sender: { uid: '42', level: 12, nobleLevel: 0 }, gift: { kind: 'prop', id: '268', count: 2 } })
    expect(session.chatHistory()[0]).toEqual(message)
  })

  it('drops malformed gift/system messages instead of converting them into repeatable chat', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!
    source.emit('danmaku', { text: 'system', system: true })
    source.emit('danmaku', { text: 'broken gift', gift: { kind: 'prop', id: '268', count: -1 } })
    source.emit('danmaku', { text: '我想送荧光棒', username: '观众' })
    expect(session.drainDanmaku()).toEqual([expect.objectContaining({ text: '我想送荧光棒' })])
    expect(session.chatHistory()[0]).not.toHaveProperty('gift')
  })

  it('applies user blocking to gifts while keeping them independent of chat patterns and density', async () => {
    const { session } = await makeSession()
    session.updateDanmakuSettings({ showGifts: true, density: 0.1, filter: { blockedPatterns: ['荧光棒'], blockedUsers: ['隐藏观众'], maxLength: 1 } })
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const gift = { kind: 'prop' as const, id: '268', count: 1 }
    session.pushDanmaku({ text: '粉丝荧光棒 x 1', user: '隐藏观众', color: '#fff', gift })
    session.pushDanmaku({ text: '粉丝荧光棒 x 1', user: '普通观众', color: '#fff', gift })
    expect(session.drainDanmaku()).toEqual([expect.objectContaining({ user: '普通观众', gift })])
    vi.mocked(Math.random).mockRestore()
  })

  it('reconnects the room that suspend parked when the player boots again', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    session.suspend()
    expect(session.flush().danmaku.room).toBeNull()
    await session.boot()
    expect(StubDanmakuSubscription.instances.at(-1)?.room).toBe('288016')
    expect(session.flush().danmaku.room).toBe('288016')
  })

  it('does not bring back a room that was disconnected before leaving', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    session.disconnectDanmaku()
    session.suspend()
    const before = StubDanmakuSubscription.instances.length
    await session.boot()
    expect(StubDanmakuSubscription.instances).toHaveLength(before)
    expect(session.flush().danmaku.room).toBeNull()
  })

  it('subscribes to the relay with a structured room id', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    expect(StubDanmakuSubscription.instances).toHaveLength(1)
    expect(StubDanmakuSubscription.instances[0]?.room).toBe('288016')
    expect(session.flush().danmaku.room).toBe('288016')
  })

  it('keeps room data intact without path encoding', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('a b/c')
    expect(StubDanmakuSubscription.instances[0]?.room).toBe('a b/c')
  })

  it('ignores unrelated relay event types', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubDanmakuSubscription.instances[0]!.emit('unexpected', { text: 'ignored' })
    expect(session.flush().danmaku.pending).toBe(0)
    expect(session.flush().danmaku.connected).toBe(false)
  })

  it('parks a relayed message against commentary media time', async () => {
    const { session } = await makeSession({ commentaryTime: 100 })
    session.connectDanmaku('288016')
    StubDanmakuSubscription.instances[0]!.emit('danmaku', { text: '好球', username: '观众', color: 0 })
    expect(session.flush().danmaku.pending).toBe(1)
    // Scheduled at the playhead it arrived on, so it is due immediately — the delay only
    // appears once the commentary is rewound behind that point.
    const [message] = session.drainDanmaku()
    expect(message?.text).toBe('好球')
    expect(message?.scheduleTime).toBeCloseTo(100, 3)
  })

  it('preserves the nickname and colour from a parsed Douyu message through the chat timeline', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const payload = toChatMessage(parseStt(
      'type@=chatmsg/cid@=nickname-regression/nn@=观众@A甲@S乙/txt@=好球/col@=2/',
    ), '288016', 123)
    StubDanmakuSubscription.instances[0]!.emit('danmaku', payload)

    expect(session.drainDanmaku()).toEqual([expect.objectContaining({
      text: '好球', user: '观众@甲/乙', color: '#1e87f0',
    })])
    expect(session.chatHistory()).toEqual([expect.objectContaining({
      text: '好球', user: '观众@甲/乙',
    })])
  })

  it('applies the username blocklist to a parsed Douyu nickname before releasing it', async () => {
    const { session } = await makeSession()
    session.updateDanmakuSettings({
      filter: { blockedPatterns: [], blockedUsers: ['刷屏机'], maxLength: 0 },
    })
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!
    source.emit('danmaku', toChatMessage(parseStt(
      'type@=chatmsg/nn@=刷屏机/txt@=应屏蔽/',
    ), '288016', 123))
    source.emit('danmaku', toChatMessage(parseStt(
      'type@=chatmsg/nn@=普通观众/txt@=好球/',
    ), '288016', 124))

    expect(session.drainDanmaku()).toEqual([expect.objectContaining({
      text: '好球', user: '普通观众',
    })])
    expect(session.chatHistory()).toHaveLength(1)
  })

  it('records released messages for the chat list, bounded and cleared on disconnect', async () => {
    const { session } = await makeSession({ commentaryTime: 100 })
    session.connectDanmaku('288016')
    let notified = 0
    const stop = session.subscribeChat(() => { notified += 1 })
    const source = StubDanmakuSubscription.instances[0]!
    for (let n = 0; n < CHAT_HISTORY_LIMIT + 5; n += 1) source.emit('danmaku', { text: `m${n}`, username: 'u', color: 0 })
    // Parked messages are not chat yet; only released ones are.
    expect(session.chatHistory()).toHaveLength(0)
    session.drainDanmaku()
    expect(notified).toBe(1)
    const history = session.chatHistory()
    expect(history.length).toBeLessThanOrEqual(CHAT_HISTORY_LIMIT)
    expect(history.at(-1)?.text).toBe(`m${CHAT_HISTORY_LIMIT + 4}`)
    expect(session.chatCount()).toBeGreaterThanOrEqual(history.length)
    session.disconnectDanmaku()
    expect(session.chatHistory()).toHaveLength(0)
    stop()
  })

  it('ignores a message with no usable text', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!
    source.emit('danmaku', { text: '', username: 'a' })
    source.emit('danmaku', { text: 42, username: 'a' })
    source.emit('danmaku', 'not json at all')
    expect(session.flush().danmaku.pending).toBe(0)
  })

  it.each([undefined, '', '   ', null, 42])('fills in an unusable nickname (%j) and missing colour', async (username) => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubDanmakuSubscription.instances[0]!.emit('danmaku', { text: '来了', username })
    const [message] = session.drainDanmaku()
    expect(message?.user).toBe('匿名')
    expect(message?.color).toBe('#ffffff')
  })

  it('reports the upstream relay state rather than local subscription success', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!

    // A local subscription exists before main has connected to Douyu.
    source.emit('state', { room: '288016', state: 'connecting' })
    expect(session.flush().danmaku.connected).toBe(false)
    expect(session.flush().danmaku.error).toBe('正在连接弹幕服务器')

    source.emit('state', { room: '288016', state: 'connected' })
    expect(session.flush().danmaku.connected).toBe(true)
    expect(session.flush().danmaku.error).toBeNull()

    source.emit('state', { room: '288016', state: 'closed' })
    expect(session.flush().danmaku.connected).toBe(false)
    expect(session.flush().danmaku.error).toBe('弹幕连接已关闭')
  })

  it('prefers the relay detail over the generic text', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubDanmakuSubscription.instances[0]!.emit('state', { state: 'closed', detail: '房间未开播' })
    expect(session.flush().danmaku.error).toBe('房间未开播')
  })

  it('survives a malformed state frame', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubDanmakuSubscription.instances[0]!
    source.emit('state', { state: 'connected' })
    source.emit('state', '{oops')
    expect(session.flush().danmaku.connected).toBe(true)
  })

  it('replaces an existing subscription instead of stacking them', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('111')
    session.connectDanmaku('222')
    expect(StubDanmakuSubscription.instances[0]?.closed).toBe(true)
    expect(session.flush().danmaku.room).toBe('222')
  })

  it('clears parked messages on disconnect', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubDanmakuSubscription.instances[0]!.emit('danmaku', { text: '一' })
    session.disconnectDanmaku()
    const { danmaku } = session.flush()
    expect(danmaku.room).toBeNull()
    expect(danmaku.connected).toBe(false)
    expect(danmaku.pending).toBe(0)
  })

  it('reports unavailable desktop transport', async () => {
    vi.stubGlobal('streamSyncer', undefined)
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    expect(session.flush().danmaku.error).toContain('弹幕连接失败')
  })

  it('ignores events queued before a room switch or disconnect', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('111')
    const stale = StubDanmakuSubscription.instances[0]!
    session.connectDanmaku('222')
    stale.emit('state', { state: 'connected' })
    stale.emit('danmaku', { text: 'old room' })
    expect(session.flush().danmaku.connected).toBe(false)
    expect(session.flush().danmaku.pending).toBe(0)
    session.disconnectDanmaku()
    StubDanmakuSubscription.instances[1]!.emit('state', { state: 'connected' })
    expect(session.flush().danmaku.room).toBeNull()
    expect(session.flush().danmaku.connected).toBe(false)
  })
})

describe('Session danmaku filtering', () => {
  it('drops a message matching a blocked pattern', async () => {
    const { session } = await makeSession()
    session.updateDanmakuSettings({
      filter: { blockedPatterns: ['广告'], blockedUsers: [], maxLength: 0 },
    })
    session.pushDanmaku({ text: '这是广告', user: 'a', color: '#fff' })
    session.pushDanmaku({ text: '好球', user: 'a', color: '#fff' })
    expect(session.drainDanmaku().map((message) => message.text)).toEqual(['好球'])
  })

  it('drops a blocked user', async () => {
    const { session } = await makeSession()
    session.updateDanmakuSettings({
      filter: { blockedPatterns: [], blockedUsers: ['刷屏机'], maxLength: 0 },
    })
    session.pushDanmaku({ text: '一', user: '刷屏机', color: '#fff' })
    expect(session.drainDanmaku()).toHaveLength(0)
  })

  it('samples on arrival so a dropped message never takes a lane', async () => {
    const { session } = await makeSession()
    session.updateDanmakuSettings({ density: 0.5 })
    // Above the threshold: rejected. Density is a load control, not a visual one.
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    session.pushDanmaku({ text: '丢', user: 'a', color: '#fff' })
    expect(session.flush().danmaku.pending).toBe(0)

    vi.spyOn(Math, 'random').mockReturnValue(0.1)
    session.pushDanmaku({ text: '留', user: 'a', color: '#fff' })
    expect(session.flush().danmaku.pending).toBe(1)
  })

  it('keeps everything at full density without consulting the sampler', async () => {
    const { session } = await makeSession()
    const random = vi.spyOn(Math, 'random')
    session.pushDanmaku({ text: '一', user: 'a', color: '#fff' })
    expect(random).not.toHaveBeenCalled()
    expect(session.flush().danmaku.pending).toBe(1)
  })
})

describe('Session danmaku and sync', () => {
  it('holds danmaku back by the amount the commentary was rewound', async () => {
    const { session, engine } = await makeSession({ commentaryTime: 100 })
    await session.loadSource('official', {
      ...descriptor(),
      url: 'https://example.test/official.mp4',
    })
    primeMediaElement(engine.element('official'), { duration: 600, currentTime: 100 })

    // A message that arrives now belongs to media time 100.
    session.pushDanmaku({ text: '现在', user: 'a', color: '#fff' })
    // Rewinding the commentary to 95 puts the playhead behind the message.
    await session.applyOffset(-5)
    expect(engine.element('commentary').currentTime).toBeCloseTo(95, 3)
    expect(session.drainDanmaku()).toHaveLength(0)

    // Playing back up to 100 releases it, in step with the picture it belongs to.
    engine.element('commentary').currentTime = 100
    expect(session.drainDanmaku().map((message) => message.text)).toEqual(['现在'])
  })

  it('shows chat as it arrives while the commentary is paused', async () => {
    const { session, engine } = await makeSession({ commentaryTime: 100 })
    await session.applyOffset(-5)
    setPaused(engine.element('commentary'), true)
    // Held back by the offset while playing; paused, it would never come and then expire.
    session.pushDanmaku({ text: '暂停时', user: 'a', color: '#fff' })
    expect(session.drainDanmaku().map((message) => message.text)).toEqual(['暂停时'])
  })

  it('expires danmaku left far behind a forward seek', async () => {
    const { session, engine } = await makeSession({ commentaryTime: 100 })
    session.pushDanmaku({ text: '旧', user: 'a', color: '#fff' })
    // 8 s is the timeline's lag budget; 60 s ahead is a seek, not a stall.
    engine.element('commentary').currentTime = 160
    expect(session.drainDanmaku()).toHaveLength(0)
    expect(session.flush().danmaku.dropped).toBeGreaterThan(0)
  })
})

describe('Session profile selection', () => {
  /** A session that comes up with a profile id already in storage, as after a reload. */
  function bootedSession(profileId: string): Session {
    const storage = memoryStorage()
    storage.setItem(SETTINGS_KEY, JSON.stringify({ profileId }))
    const session = new Session({
      engine: new MediaEngine(),
      storage,
      createSampler: () => null,
    })
    sessions.push(session)
    return session
  }

  /** Answer the typed preset methods while leaving the rest of the preload intact. */
  function stubApi(handlers: { list?: unknown; presets?: Record<string, unknown> }): { calls: string[] } {
    const calls: string[] = []
    const bridge = preload()
    bridge.invoke = vi.fn(async (method: string, args?: { id: string }) => {
      calls.push(method === 'getPreset' ? `getPreset:${args?.id}` : method)
      if (method === 'listPresets') return { ok: true, value: handlers.list ?? { presets: [] } }
      const found = handlers.presets?.[args?.id ?? '']
      if (!found) return { ok: false, code: 'not-found', message: 'Preset not found' }
      return { ok: true, value: found }
    }) as StreamSyncerBridge['invoke']
    vi.stubGlobal('streamSyncer', bridge)
    return { calls }
  }

  it('fetches the chosen preset and applies it to both roles', async () => {
    const profile = readyProfile()
    stubApi({ presets: { 'cs2/iem': { profile, etag: 'abc' } } })
    const { session } = await makeSession({ load: false })

    await expect(session.selectProfile('cs2/iem')).resolves.toBe(true)
    // Both roles share one profile: it is the same on-screen clock.
    expect(session.profileFor('official')?.id).toBe('cs2/iem')
    expect(session.profileFor('commentary')?.id).toBe('cs2/iem')
    // And the id is persisted, because 返回播放器 is a real navigation.
    expect(session.settings.profileId).toBe('cs2/iem')
  })

  it('passes the preset id as IPC data without URL escaping', async () => {
    const { calls } = stubApi({ presets: { 'cs2/iem': { profile: readyProfile(), etag: 'a' } } })
    const { session } = await makeSession({ load: false })
    await session.selectProfile('cs2/iem')
    expect(calls).toContain('getPreset:cs2/iem')
  })

  it('reports a failed fetch and keeps the previous profile', async () => {
    stubApi({ presets: { 'cs2/iem': { profile: readyProfile(), etag: 'a' } } })
    const { session } = await makeSession({ load: false })
    await session.selectProfile('cs2/iem')

    await expect(session.selectProfile('missing/one')).resolves.toBe(false)
    expect(session.profileFor('official')?.id).toBe('cs2/iem')
    // A stored id pointing at nothing must not be written over the working one.
    expect(session.settings.profileId).toBe('cs2/iem')
    expect(session.flush().notices[0]?.kind).toBe('error')
  })

  it('refuses a profile the schema rejects', async () => {
    // The server validates on write, but a preset file can be hand-edited after that.
    stubApi({ presets: { 'bad/one': { profile: { schemaVersion: 2, id: 'bad/one' }, etag: 'a' } } })
    const { session } = await makeSession({ load: false })
    await expect(session.selectProfile('bad/one')).resolves.toBe(false)
    expect(session.profileFor('official')).toBeNull()
    expect(session.flush().notices[0]?.text).toContain('格式无效')
  })

  it('clears the selection for an empty id', async () => {
    stubApi({ presets: { 'cs2/iem': { profile: readyProfile(), etag: 'a' } } })
    const { session } = await makeSession({ load: false })
    await session.selectProfile('cs2/iem')
    await session.selectProfile('')
    expect(session.profileFor('official')).toBeNull()
    expect(session.settings.profileId).toBe('')
  })

  it('lists presets for the player picker', async () => {
    stubApi({
      list: {
        presets: [{ id: 'cs2/iem', name: 'IEM', updatedAt: 1, etag: 'a', templateChars: 11 }],
      },
    })
    const { session } = await makeSession({ load: false })
    await session.refreshPresets()
    expect(session.flush().presets).toHaveLength(1)
    expect(session.flush().presets[0]?.name).toBe('IEM')
  })

  it('restores the stored selection on boot', async () => {
    const profile = readyProfile()
    stubApi({
      list: {
        presets: [{ id: 'cs2/iem', name: 'IEM', updatedAt: 1, etag: 'a', templateChars: 11 }],
      },
      presets: { 'cs2/iem': { profile, etag: 'a' } },
    })
    const session = bootedSession('cs2/iem')
    await session.boot()
    expect(session.profileFor('commentary')?.id).toBe('cs2/iem')
  })

  it('forgets a stored selection the server no longer has', async () => {
    stubApi({ list: { presets: [] } })
    const session = bootedSession('deleted/one')

    await session.boot()
    // Cleared silently: warning about it on every boot would be noise, not information.
    expect(session.settings.profileId).toBe('')
    expect(session.flush().notices).toHaveLength(0)
  })

  it('leaves the selection alone when the server is unreachable', async () => {
    const bridge = preload()
    vi.mocked(bridge.invoke).mockRejectedValue(new Error('channel closed'))
    vi.stubGlobal('streamSyncer', bridge)
    const session = bootedSession('cs2/iem')

    await session.boot()
    // A dead server is not evidence the preset is gone.
    expect(session.settings.profileId).toBe('cs2/iem')
  })
})
