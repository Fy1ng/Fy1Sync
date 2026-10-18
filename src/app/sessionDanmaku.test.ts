/**
 * The session's danmaku and profile plumbing.
 *
 * Two things jsdom does not provide are stubbed here, and only those two: `EventSource`
 * and `fetch`. Everything downstream stays real — the filter, the timeline, the scheduling
 * against commentary media time — because that chain is where the bugs live. In particular
 * the SSE *event names* are asserted, since an EventSource silently ignores events nobody
 * listens for: a mismatch between relay and client drops every message with no error
 * anywhere, which is exactly what happened once.
 */

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
import { Session } from './session'
import { SETTINGS_KEY, type SettingsStorage } from './settings'

/** A stub EventSource that hands the test its own listener table. */
class StubEventSource {
  static instances: StubEventSource[] = []
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  closed = false

  constructor(readonly url: string) {
    StubEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler)
  }

  removeEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver one server-sent event, as the browser would. */
  emit(type: string, data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new MessageEvent(type, { data: payload }))
    }
  }

  /** Whether the client is listening for a given event name at all. */
  listens(type: string): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0
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
  }
  return { session, engine }
}

beforeEach(() => {
  StubEventSource.instances = []
  vi.stubGlobal('EventSource', StubEventSource as unknown as typeof EventSource)
})

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.dispose()
  vi.unstubAllGlobals()
})

describe('Session danmaku transport', () => {
  it('subscribes to the relay with the room in the path', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    expect(StubEventSource.instances).toHaveLength(1)
    expect(StubEventSource.instances[0]?.url).toBe('/api/danmaku/douyu/288016')
    expect(session.flush().danmaku.room).toBe('288016')
  })

  it('escapes the room id into the path', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('a b/c')
    expect(StubEventSource.instances[0]?.url).toBe('/api/danmaku/douyu/a%20b%2Fc')
  })

  it('listens for the event names the relay actually sends', async () => {
    // Named explicitly: an EventSource drops events with no listener, so a rename on
    // either side is invisible until nothing shows up on screen.
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubEventSource.instances[0]!
    expect(source.listens('danmaku')).toBe(true)
    expect(source.listens('state')).toBe(true)
  })

  it('parks a relayed message against commentary media time', async () => {
    const { session } = await makeSession({ commentaryTime: 100 })
    session.connectDanmaku('288016')
    StubEventSource.instances[0]!.emit('danmaku', { text: '好球', user: '观众', color: '#fff' })
    expect(session.flush().danmaku.pending).toBe(1)
    // Scheduled at the playhead it arrived on, so it is due immediately — the delay only
    // appears once the commentary is rewound behind that point.
    const [message] = session.drainDanmaku()
    expect(message?.text).toBe('好球')
    expect(message?.scheduleTime).toBeCloseTo(100, 3)
  })

  it('ignores a message with no usable text', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubEventSource.instances[0]!
    source.emit('danmaku', { text: '', user: 'a' })
    source.emit('danmaku', { text: 42, user: 'a' })
    source.emit('danmaku', 'not json at all')
    expect(session.flush().danmaku.pending).toBe(0)
  })

  it('fills in a missing user and colour rather than dropping the message', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubEventSource.instances[0]!.emit('danmaku', { text: '来了' })
    const [message] = session.drainDanmaku()
    expect(message?.user).toBe('匿名')
    expect(message?.color).toBe('#ffffff')
  })

  it('reports the relay state rather than only the SSE pipe', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubEventSource.instances[0]!

    // `open` means the pipe is up, which happens before the server has reached Douyu.
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
    StubEventSource.instances[0]!.emit('state', { state: 'closed', detail: '房间未开播' })
    expect(session.flush().danmaku.error).toBe('房间未开播')
  })

  it('survives a malformed state frame', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    const source = StubEventSource.instances[0]!
    source.emit('state', { state: 'connected' })
    source.emit('state', '{oops')
    expect(session.flush().danmaku.connected).toBe(true)
  })

  it('replaces an existing subscription instead of stacking them', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('111')
    session.connectDanmaku('222')
    expect(StubEventSource.instances[0]?.closed).toBe(true)
    expect(session.flush().danmaku.room).toBe('222')
  })

  it('clears parked messages on disconnect', async () => {
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    StubEventSource.instances[0]!.emit('danmaku', { text: '一' })
    session.disconnectDanmaku()
    const { danmaku } = session.flush()
    expect(danmaku.room).toBeNull()
    expect(danmaku.connected).toBe(false)
    expect(danmaku.pending).toBe(0)
  })

  it('says so when the environment has no SSE', async () => {
    vi.stubGlobal('EventSource', undefined)
    const { session } = await makeSession()
    session.connectDanmaku('288016')
    expect(session.flush().danmaku.error).toBe('当前环境不支持 SSE')
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

  /**
   * Answer `/api/presets*` and record what was asked for.
   *
   * Hand-rolled rather than `new Response(...)`: `apiClient` only ever reads `ok`, `status`
   * and `text()`, and jsdom is not obliged to supply a global `Response`.
   */
  function stubApi(handlers: { list?: unknown; presets?: Record<string, unknown> }): {
    calls: string[]
  } {
    const calls: string[] = []
    const reply = (payload: unknown, status = 200): Promise<Response> =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as unknown as Response)

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        if (url === '/api/presets') return reply(handlers.list ?? { presets: [] })
        const id = decodeURIComponent(url.replace('/api/presets/', ''))
        const found = handlers.presets?.[id]
        if (!found) return reply({ error: { code: 'not-found', message: '预设不存在' } }, 404)
        return reply(found)
      }),
    )
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

  it('does not escape the slash in a preset id, which is path structure', async () => {
    const { calls } = stubApi({ presets: { 'cs2/iem': { profile: readyProfile(), etag: 'a' } } })
    const { session } = await makeSession({ load: false })
    await session.selectProfile('cs2/iem')
    expect(calls).toContain('/api/presets/cs2/iem')
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
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    const session = bootedSession('cs2/iem')

    await session.boot()
    // A dead server is not evidence the preset is gone.
    expect(session.settings.profileId).toBe('cs2/iem')
  })
})
