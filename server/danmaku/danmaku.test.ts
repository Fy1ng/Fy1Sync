import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_MESSAGE_TYPE,
  colorForIndex,
  decodeFrames,
  encodeFrame,
  escapeStt,
  JOIN_GROUP_REQUEST,
  LOGIN_REQUEST,
  parseStt,
  SERVER_MESSAGE_TYPE,
  serializeStt,
  toChatMessage,
  unescapeStt,
} from './douyuProtocol'
import { DouyuDanmakuClient, type WebSocketLike } from './douyuClient'
import { DanmakuRelay, MAX_ROOMS } from './relay'

describe('encodeFrame', () => {
  it('writes the length twice, excluding the length field itself', () => {
    const frame = encodeFrame('ab')
    // 2 payload bytes + type(2) + encrypt(1) + reserved(1) + NUL(1) + one length field(4).
    expect(frame.readUInt32LE(0)).toBe(11)
    expect(frame.readUInt32LE(4)).toBe(11)
    expect(frame.byteLength).toBe(15)
    // The declared length must describe everything after the first field.
    expect(frame.readUInt32LE(0) + 4).toBe(frame.byteLength)
  })

  it('defaults to the client message type and terminates with NUL', () => {
    const frame = encodeFrame('type@=mrkl/')
    expect(frame.readUInt16LE(8)).toBe(CLIENT_MESSAGE_TYPE)
    expect(frame.readUInt8(10)).toBe(0)
    expect(frame.readUInt8(11)).toBe(0)
    expect(frame.readUInt8(frame.byteLength - 1)).toBe(0)
  })

  it('accepts an explicit type', () => {
    expect(encodeFrame('x', SERVER_MESSAGE_TYPE).readUInt16LE(8)).toBe(SERVER_MESSAGE_TYPE)
  })

  it('measures multi-byte payloads in bytes, not characters', () => {
    const frame = encodeFrame('弹幕')
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength('弹幕', 'utf8') + 9)
  })
})

describe('decodeFrames', () => {
  it('round-trips a single frame', () => {
    const { payloads, rest } = decodeFrames(encodeFrame('type@=chatmsg/txt@=hi/'))
    expect(payloads).toEqual(['type@=chatmsg/txt@=hi/'])
    expect(rest.byteLength).toBe(0)
  })

  it('splits coalesced frames arriving in one chunk', () => {
    const buffer = Buffer.concat([encodeFrame('a@=1/'), encodeFrame('b@=2/'), encodeFrame('c@=3/')])
    const { payloads, rest } = decodeFrames(buffer)
    expect(payloads).toEqual(['a@=1/', 'b@=2/', 'c@=3/'])
    expect(rest.byteLength).toBe(0)
  })

  it('keeps a partial trailing frame as leftover bytes', () => {
    const whole = encodeFrame('first@=1/')
    const partial = encodeFrame('second@=2/')
    const buffer = Buffer.concat([whole, partial.subarray(0, 8)])
    const { payloads, rest } = decodeFrames(buffer)
    expect(payloads).toEqual(['first@=1/'])
    expect(rest.byteLength).toBe(8)
    // Feeding the remainder later must complete the frame.
    const completed = decodeFrames(Buffer.concat([rest, partial.subarray(8)]))
    expect(completed.payloads).toEqual(['second@=2/'])
  })

  it('holds a frame whose header is not yet complete', () => {
    const frame = encodeFrame('x@=1/')
    const { payloads, rest } = decodeFrames(frame.subarray(0, 10))
    expect(payloads).toEqual([])
    expect(rest.byteLength).toBe(10)
  })

  it('drops the buffer on an impossibly small length instead of stalling', () => {
    const bogus = Buffer.alloc(16)
    bogus.writeUInt32LE(3, 0)
    const { payloads, rest } = decodeFrames(bogus)
    expect(payloads).toEqual([])
    // Returning the bytes would mean waiting forever for a frame that cannot arrive.
    expect(rest.byteLength).toBe(0)
  })

  it('drops the buffer on an oversized length', () => {
    const bogus = Buffer.alloc(16)
    bogus.writeUInt32LE(2_000_000, 0)
    expect(decodeFrames(bogus).rest.byteLength).toBe(0)
  })

  it('skips empty payloads', () => {
    const { payloads } = decodeFrames(encodeFrame(''))
    expect(payloads).toEqual([])
  })
})

describe('STT escaping', () => {
  it('escapes @ before / so the two cannot be confused', () => {
    expect(escapeStt('a@b/c')).toBe('a@Ab@Sc')
    expect(unescapeStt('a@Ab@Sc')).toBe('a@b/c')
  })

  it('round-trips text that already looks like an escape sequence', () => {
    for (const value of ['@S', '@A', '@@', '//', 'plain', '@A@S/@']) {
      expect(unescapeStt(escapeStt(value))).toBe(value)
    }
  })

  it('serializes and parses a field map', () => {
    const payload = serializeStt({ type: 'loginreq', roomid: '288016', gid: -9999 })
    expect(payload).toBe('type@=loginreq/roomid@=288016/gid@=-9999/')
    expect(parseStt(payload)).toEqual({ type: 'loginreq', roomid: '288016', gid: '-9999' })
  })

  it('carries values containing separators through a round trip', () => {
    const parsed = parseStt(serializeStt({ txt: 'gg/wp@home' }))
    expect(parsed.txt).toBe('gg/wp@home')
  })

  it('ignores pairs without a separator and empty keys', () => {
    expect(parseStt('garbage/type@=chatmsg/@=novalue/')).toEqual({ type: 'chatmsg' })
  })

  it('accepts an empty value', () => {
    expect(parseStt('txt@=/type@=chatmsg/')).toEqual({ txt: '', type: 'chatmsg' })
  })

  it('keeps a nested group as a raw string', () => {
    // A nested group is double-escaped upstream; one unescape leaves the inner payload.
    const nested = parseStt(`type@=chatmsg/txt@=hi/bnn@=${escapeStt('a@=1/b@=2/')}/`)
    expect(nested.bnn).toBe('a@=1/b@=2/')
  })

  it('builds the login and join requests for a room', () => {
    expect(LOGIN_REQUEST('288016')).toContain('roomid@=288016')
    expect(JOIN_GROUP_REQUEST('288016')).toContain('rid@=288016')
    expect(JOIN_GROUP_REQUEST('288016')).toContain('gid@=-9999')
  })
})

describe('toChatMessage', () => {
  const chat = { type: 'chatmsg', cid: 'c1', txt: '  nice shot  ', nn: 'viewer', col: '2', level: '30' }

  it('maps a chat payload', () => {
    const message = toChatMessage(chat, '288016', 1_000)
    expect(message).toEqual({
      id: 'c1',
      text: 'nice shot',
      username: 'viewer',
      color: 2,
      level: 30,
      receivedAt: 1_000,
      room: '288016',
      system: false,
    })
  })

  it('ignores non-chat traffic and blank text', () => {
    expect(toChatMessage({ type: 'mrkl' }, '1', 0)).toBeNull()
    expect(toChatMessage({ type: 'chatmsg', txt: '   ' }, '1', 0)).toBeNull()
    expect(toChatMessage({ type: 'chatmsg' }, '1', 0)).toBeNull()
  })

  it('falls back to a synthetic id and anonymous name', () => {
    const message = toChatMessage({ type: 'chatmsg', txt: 'x' }, '1', 42)
    expect(message?.id).toContain('42-')
    expect(message?.username).toBe('匿名')
    expect(message?.color).toBe(0)
  })

  it('coerces a non-numeric colour or level to zero', () => {
    const message = toChatMessage({ type: 'chatmsg', txt: 'x', col: 'red', level: '' }, '1', 0)
    expect(message?.color).toBe(0)
    expect(message?.level).toBe(0)
  })

  it('maps colour indices, defaulting unknown ones to white', () => {
    expect(colorForIndex(0)).toBe('#ffffff')
    expect(colorForIndex(1)).toBe('#ff0000')
    expect(colorForIndex(99)).toBe('#ffffff')
  })
})

/** A socket whose listeners can be fired by hand, recording everything sent. */
function fakeSocket(): WebSocketLike & {
  fire: (type: string, event?: unknown) => void
  sent: Buffer[]
  closed: number
} {
  const listeners = new Map<string, Array<(event: any) => void>>()
  const sent: Buffer[] = []
  return {
    sent,
    closed: 0,
    send(data) {
      sent.push(Buffer.from(data as Uint8Array))
    },
    close() {
      this.closed += 1
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    fire(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
}

/** Manual clock so reconnect backoff and keepalive can be driven deterministically. */
function fakeTimers() {
  let seq = 0
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const handle = ++seq
      pending.set(handle, { fn, ms })
      return handle
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number)
    },
    get size() {
      return pending.size
    },
    delays: () => [...pending.values()].map((entry) => entry.ms),
    runAll: () => {
      const entries = [...pending.entries()]
      pending.clear()
      for (const [, entry] of entries) entry.fn()
    },
  }
}

describe('DouyuDanmakuClient', () => {
  /**
   * A real WebSocket is a new object per connection, so each `connect()` gets a fresh
   * double. `socket` is a getter for the live one; reusing a single instance would stack
   * listeners and fire each handler once per past connection.
   */
  function setup() {
    const sockets: Array<ReturnType<typeof fakeSocket>> = []
    const timers = fakeTimers()
    const messages: unknown[] = []
    const states: Array<[string, string | undefined]> = []
    const client = new DouyuDanmakuClient(
      '288016',
      {
        onMessage: (message) => messages.push(message),
        onState: (state, detail) => states.push([state, detail]),
      },
      {
        createSocket: () => {
          const socket = fakeSocket()
          sockets.push(socket)
          return socket
        },
        now: () => 5_000,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    )
    return {
      timers,
      messages,
      states,
      client,
      sockets,
      get socket() {
        return sockets.at(-1)!
      },
    }
  }

  it('logs in and joins the group on open', () => {
    const harness = setup()
    harness.client.connect()
    expect(harness.states.map(([state]) => state)).toEqual(['connecting'])
    harness.socket.fire('open')
    expect(harness.client.state).toBe('connected')
    expect(harness.socket.sent).toHaveLength(2)
    expect(decodeFrames(harness.socket.sent[0]!).payloads[0]).toContain('type@=loginreq')
    expect(decodeFrames(harness.socket.sent[1]!).payloads[0]).toContain('type@=joingroup')
  })

  it('emits chat messages from received frames', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    harness.socket.fire('message', {
      data: encodeFrame('type@=chatmsg/txt@=hello/nn@=a/', SERVER_MESSAGE_TYPE),
    })
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({ text: 'hello', room: '288016', receivedAt: 5_000 })
  })

  it('reassembles a message split across two chunks', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    const frame = encodeFrame('type@=chatmsg/txt@=split/', SERVER_MESSAGE_TYPE)
    harness.socket.fire('message', { data: frame.subarray(0, 9) })
    expect(harness.messages).toHaveLength(0)
    harness.socket.fire('message', { data: frame.subarray(9) })
    expect(harness.messages).toHaveLength(1)
  })

  it('accepts ArrayBuffer and typed-array payloads', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    const frame = encodeFrame('type@=chatmsg/txt@=ab/', SERVER_MESSAGE_TYPE)
    const copy = new Uint8Array(frame)
    harness.socket.fire('message', { data: copy.buffer.slice(0) })
    harness.socket.fire('message', { data: copy })
    expect(harness.messages).toHaveLength(2)
  })

  it('ignores payload types it cannot read', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    harness.socket.fire('message', { data: 42 })
    harness.socket.fire('message', { data: null })
    expect(harness.messages).toHaveLength(0)
  })

  it('sends a keepalive when the timer fires and re-arms', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    expect(harness.timers.delays()).toEqual([40_000])
    harness.timers.runAll()
    expect(decodeFrames(harness.socket.sent[2]!).payloads[0]).toContain('type@=mrkl')
    expect(harness.timers.delays()).toEqual([40_000])
  })

  it('backs off exponentially across reconnects', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    harness.socket.fire('close', { reason: 'gone' })
    expect(harness.client.state).toBe('reconnecting')
    expect(harness.timers.delays()).toEqual([1_000])

    harness.timers.runAll() // reconnect -> connect()
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([2_000])
    harness.timers.runAll()
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([4_000])
  })

  it('caps the backoff delay', () => {
    const harness = setup()
    harness.client.connect()
    for (let i = 0; i < 12; i += 1) {
      harness.socket.fire('close', {})
      harness.timers.runAll()
    }
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([30_000])
  })

  it('resets the backoff after a successful open', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('close', {})
    harness.timers.runAll()
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([2_000])
    harness.timers.runAll()
    harness.socket.fire('open')
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([1_000])
  })

  it('ignores a stale close from a socket it already replaced', () => {
    const harness = setup()
    harness.client.connect()
    const first = harness.socket
    first.fire('close', {})
    harness.timers.runAll()
    expect(harness.sockets).toHaveLength(2)
    // A real socket emits `close` after our own `close()` call; the backoff must not move.
    first.fire('close', {})
    first.fire('open')
    expect(harness.client.state).toBe('connecting')
    harness.socket.fire('close', {})
    expect(harness.timers.delays()).toEqual([2_000])
  })

  it('reports the error detail on the reconnecting state', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('error', { message: 'ECONNRESET' })
    expect(harness.states.at(-1)).toEqual(['reconnecting', 'ECONNRESET'])
  })

  it('schedules a reconnect when the socket cannot even be created', () => {
    const timers = fakeTimers()
    const states: string[] = []
    const client = new DouyuDanmakuClient(
      '1',
      { onMessage: () => {}, onState: (state) => states.push(state) },
      {
        createSocket: () => {
          throw new Error('dns')
        },
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
      },
    )
    client.connect()
    expect(states).toEqual(['connecting', 'reconnecting'])
    expect(timers.delays()).toEqual([1_000])
  })

  it('stops reconnecting once closed by the caller', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    const socket = harness.socket
    harness.client.close()
    expect(harness.client.state).toBe('closed')
    expect(harness.timers.size).toBe(0)
    socket.fire('close', {})
    expect(harness.client.state).toBe('closed')
    expect(harness.timers.size).toBe(0)
  })

  it('does not open a second socket while one is live', () => {
    const socket = fakeSocket()
    let created = 0
    const client = new DouyuDanmakuClient(
      '1',
      { onMessage: () => {}, onState: () => {} },
      {
        createSocket: () => {
          created += 1
          return socket
        },
      },
    )
    client.connect()
    client.connect()
    expect(created).toBe(1)
    client.close()
  })

  it('survives a send on a socket that throws', () => {
    const socket = fakeSocket()
    socket.send = () => {
      throw new Error('closed')
    }
    const client = new DouyuDanmakuClient(
      '1',
      { onMessage: () => {}, onState: () => {} },
      { createSocket: () => socket },
    )
    client.connect()
    expect(() => socket.fire('open')).not.toThrow()
    client.close()
  })

  it('discards buffered bytes on teardown so frames cannot span connections', () => {
    const harness = setup()
    harness.client.connect()
    harness.socket.fire('open')
    const frame = encodeFrame('type@=chatmsg/txt@=x/', SERVER_MESSAGE_TYPE)
    harness.socket.fire('message', { data: frame.subarray(0, 9) })
    harness.socket.fire('close', {})
    harness.timers.runAll()
    harness.socket.fire('open')
    // The tail of the old frame must not be glued onto the new connection's first bytes.
    harness.socket.fire('message', { data: frame.subarray(9) })
    expect(harness.messages).toHaveLength(0)
  })
})

describe('DanmakuRelay', () => {
  function relaySetup() {
    const sockets: Array<ReturnType<typeof fakeSocket>> = []
    const timers = fakeTimers()
    const relay = new DanmakuRelay({
      createSocket: () => {
        const socket = fakeSocket()
        sockets.push(socket)
        return socket
      },
      now: () => 1_000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    return { relay, sockets, timers }
  }

  function recorder() {
    const events: Array<[string, any]> = []
    return {
      events,
      write: (event: string, data: unknown) => events.push([event, data]),
      close: vi.fn(),
    }
  }

  it('opens one upstream connection per room and shares it', () => {
    const { relay, sockets } = relaySetup()
    relay.subscribe('288016', recorder())
    relay.subscribe('288016', recorder())
    expect(sockets).toHaveLength(1)
    expect(relay.subscriberCount('288016')).toBe(2)
    expect(relay.roomCount).toBe(1)
    relay.closeAll()
  })

  it('sends the current state to a new subscriber immediately', () => {
    const { relay } = relaySetup()
    const first = recorder()
    relay.subscribe('288016', first)
    expect(first.events[0]).toEqual(['state', { room: '288016', state: 'connecting', detail: undefined }])
    relay.closeAll()
  })

  it('fans a message out to every subscriber', () => {
    const { relay, sockets } = relaySetup()
    const a = recorder()
    const b = recorder()
    relay.subscribe('288016', a)
    relay.subscribe('288016', b)
    sockets[0]!.fire('open')
    sockets[0]!.fire('message', { data: encodeFrame('type@=chatmsg/txt@=hi/', SERVER_MESSAGE_TYPE) })
    expect(a.events.filter(([event]) => event === 'danmaku')).toHaveLength(1)
    expect(b.events.filter(([event]) => event === 'danmaku')).toHaveLength(1)
    relay.closeAll()
  })

  it('replays recent messages to a late subscriber, capped at the replay limit', () => {
    const { relay, sockets } = relaySetup()
    relay.subscribe('288016', recorder())
    sockets[0]!.fire('open')
    for (let i = 0; i < 60; i += 1) {
      sockets[0]!.fire('message', { data: encodeFrame(`type@=chatmsg/txt@=m${i}/`, SERVER_MESSAGE_TYPE) })
    }
    const late = recorder()
    relay.subscribe('288016', late)
    const replayed = late.events.filter(([event]) => event === 'danmaku')
    expect(replayed).toHaveLength(50)
    // The oldest ten are dropped, so the window is the most recent messages.
    expect(replayed[0]![1].text).toBe('m10')
    expect(replayed.at(-1)![1].text).toBe('m59')
    relay.closeAll()
  })

  it('broadcasts upstream state changes', () => {
    const { relay, sockets } = relaySetup()
    const subscriber = recorder()
    relay.subscribe('288016', subscriber)
    sockets[0]!.fire('open')
    expect(subscriber.events.at(-1)).toEqual(['state', { room: '288016', state: 'connected', detail: undefined }])
    expect(relay.stateOf('288016')).toBe('connected')
    relay.closeAll()
  })

  it('drops a subscriber whose write throws', () => {
    const { relay, sockets } = relaySetup()
    const good = recorder()
    relay.subscribe('288016', {
      write: (event) => {
        if (event === 'danmaku') throw new Error('EPIPE')
      },
      close: () => {},
    })
    relay.subscribe('288016', good)
    sockets[0]!.fire('open')
    sockets[0]!.fire('message', { data: encodeFrame('type@=chatmsg/txt@=x/', SERVER_MESSAGE_TYPE) })
    expect(relay.subscriberCount('288016')).toBe(1)
    expect(good.events.filter(([event]) => event === 'danmaku')).toHaveLength(1)
    relay.closeAll()
  })

  it('keeps the room alive for a grace period after the last subscriber leaves', () => {
    const { relay, sockets, timers } = relaySetup()
    const unsubscribe = relay.subscribe('288016', recorder())
    sockets[0]!.fire('open')
    unsubscribe!()
    // Still registered: a page reload within the grace period reuses the connection.
    expect(relay.roomCount).toBe(1)
    expect(timers.delays()).toContain(10_000)
    timers.runAll()
    expect(relay.roomCount).toBe(0)
  })

  it('releases the upstream after the last renderer fails to receive a message', () => {
    const { relay, sockets, timers } = relaySetup()
    relay.subscribe('288016', {
      write: (event) => { if (event === 'danmaku') throw new Error('Renderer destroyed') },
      close: () => {},
    })
    sockets[0]!.fire('open')
    sockets[0]!.fire('message', { data: encodeFrame('type@=chatmsg/txt@=x/', SERVER_MESSAGE_TYPE) })
    expect(relay.subscriberCount('288016')).toBe(0)
    expect(timers.delays()).toContain(10_000)
    timers.runAll()
    expect(relay.roomCount).toBe(0)
  })

  it('does not retain a renderer that fails during initial state delivery', () => {
    const { relay, timers } = relaySetup()
    expect(() => relay.subscribe('288016', { write: () => { throw new Error('Renderer destroyed') }, close: () => {} })).not.toThrow()
    expect(relay.subscriberCount('288016')).toBe(0)
    timers.runAll()
    expect(relay.roomCount).toBe(0)
  })

  it('keeps teardown idempotent even when a destroyed renderer close throws', () => {
    const { relay, timers } = relaySetup()
    const unsubscribe = relay.subscribe('288016', { write: () => {}, close: () => { throw new Error('Renderer destroyed') } })!
    expect(() => relay.closeAll()).not.toThrow()
    unsubscribe()
    unsubscribe()
    expect(timers.size).toBe(0)
    expect(relay.roomCount).toBe(0)
  })

  it('cancels the idle close when a subscriber returns in time', () => {
    const { relay, sockets, timers } = relaySetup()
    const unsubscribe = relay.subscribe('288016', recorder())
    sockets[0]!.fire('open')
    unsubscribe!()
    relay.subscribe('288016', recorder())
    timers.runAll()
    expect(relay.roomCount).toBe(1)
    expect(sockets).toHaveLength(1)
    relay.closeAll()
  })

  it('refuses a new room past the cap but still accepts existing ones', () => {
    const { relay } = relaySetup()
    for (let i = 0; i < MAX_ROOMS; i += 1) {
      expect(relay.subscribe(`room${i}`, recorder())).not.toBeNull()
    }
    expect(relay.subscribe('one-too-many', recorder())).toBeNull()
    expect(relay.subscribe('room0', recorder())).not.toBeNull()
    expect(relay.roomCount).toBe(MAX_ROOMS)
    relay.closeAll()
  })

  it('reports idle for an unknown room', () => {
    const { relay } = relaySetup()
    expect(relay.stateOf('nope')).toBe('idle')
    expect(relay.subscriberCount('nope')).toBe(0)
  })

  it('closes every subscriber and socket on closeAll', () => {
    const { relay, sockets } = relaySetup()
    const subscriber = recorder()
    relay.subscribe('288016', subscriber)
    relay.subscribe('288017', recorder())
    relay.closeAll()
    expect(subscriber.close).toHaveBeenCalled()
    expect(sockets.every((socket) => socket.closed > 0)).toBe(true)
    expect(relay.roomCount).toBe(0)
  })
})
