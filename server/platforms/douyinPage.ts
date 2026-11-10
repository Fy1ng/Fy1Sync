/** Read public room state from JSON/RSC data. Never execute a page's JavaScript. */
import { MAX_PLATFORM_RESPONSE_BYTES } from '../platformResponse'

export type JsonRecord = Record<string, unknown>
export const asRecord = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
export function douyinId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

export interface DouyinRoomData {
  webRoom?: string
  roomId?: string
  status: unknown
  title?: unknown
  stream: JsonRecord
  h264: JsonRecord
}

const MAX_ROWS = 4096
const MAX_NODES = 16_384
const MAX_DEPTH = 48

class Models {
  constructor(readonly rows = new Map<string, unknown>()) {}

  value(raw: unknown): unknown {
    const seen = new Set<string>()
    let result = raw
    while (typeof result === 'string' && /^\$[a-f0-9]{1,8}$/i.test(result)) {
      const id = result.slice(1)
      if (!this.rows.has(id) || seen.has(id) || seen.size >= MAX_DEPTH) return undefined
      seen.add(id)
      result = this.rows.get(id)
    }
    return result
  }

  record(raw: unknown): JsonRecord { return asRecord(this.value(raw)) }

  /** Expand only the media subtree, with a budget shared across every reference. */
  media(raw: unknown): JsonRecord {
    let budget = MAX_NODES
    const ancestors = new Set<unknown>()
    const visit = (input: unknown, depth: number): unknown => {
      if (--budget < 0 || depth > MAX_DEPTH) throw new Error('Invalid media state')
      const value = this.value(input)
      if (!value || typeof value !== 'object') return value
      if (ancestors.has(value)) throw new Error('Cyclic media state')
      ancestors.add(value)
      const result = Array.isArray(value) ? value.map(item => visit(item, depth + 1))
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, depth + 1)]))
      ancestors.delete(value)
      return result
    }
    return asRecord(visit(raw, 0))
  }

  room(expectedWebRoom?: string): DouyinRoomData | null {
    const stack = [...this.rows.values()].map(value => ({ value, depth: 0 }))
    const visited = new Set<unknown>()
    let nodes = 0
    while (stack.length && ++nodes <= MAX_NODES) {
      const next = stack.pop()!
      if (next.depth > MAX_DEPTH) continue
      const value = this.value(next.value)
      if (!value || typeof value !== 'object' || visited.has(value)) continue
      visited.add(value)
      const state = asRecord(value)
      const info = this.record(this.record(state.roomStore).roomInfo)
      const room = this.record(info.room)
      if (Object.hasOwn(room, 'status')) {
        const webRoom = douyinId(this.value(info.web_rid))
        // A page may contain recommended rooms; never switch the viewer's selected room.
        if (expectedWebRoom && webRoom && expectedWebRoom !== webRoom) continue
        const camera = this.record(this.record(state.cameraStore).cameraInfo)
        return { webRoom: webRoom ?? expectedWebRoom,
          roomId: douyinId(this.value(info.roomId)) ?? douyinId(this.value(room.id_str)),
          status: this.value(room.status), title: this.value(room.title),
          stream: this.media(room.stream_url), h264: this.media(camera.h264Stream) }
      }
      // The official mobile share page embeds protobuf JSON with camelCase fields.
      if (Object.hasOwn(state, 'status') && douyinId(this.value(state.idStr))) {
        const owner = this.record(state.owner)
        const webRoom = douyinId(this.value(owner.webRid))
        if (expectedWebRoom && webRoom && expectedWebRoom !== webRoom) continue
        return { webRoom, roomId: douyinId(this.value(state.idStr)), status: this.value(state.status),
          title: this.value(state.title), stream: normalizeDouyinStream(this.media(state.streamUrl)), h264: {} }
      }
      for (const child of Object.values(value)) stack.push({ value: child, depth: next.depth + 1 })
    }
    return null
  }
}

/** RSC T records count UTF-8 bytes, and can cross script-chunk boundaries. */
function flightRows(chunks: string[]): Map<string, unknown> {
  const bytes = Buffer.from(chunks.join(''), 'utf8')
  if (bytes.length > MAX_PLATFORM_RESPONSE_BYTES) throw new Error('Large flight data')
  const rows = new Map<string, unknown>()
  let offset = 0, count = 0
  while (offset < bytes.length) {
    if (bytes[offset] === 10) { offset++; continue }
    if (++count > MAX_ROWS) throw new Error('Too many flight records')
    const colon = bytes.indexOf(58, offset)
    if (colon < 0 || colon - offset > 8) throw new Error('Invalid flight record')
    const id = bytes.subarray(offset, colon).toString('ascii')
    if (!/^[a-f0-9]{1,8}$/i.test(id)) throw new Error('Invalid flight id')
    offset = colon + 1
    if (bytes[offset] === 84) {
      const comma = bytes.indexOf(44, offset)
      if (comma < 0 || comma - offset > 9) throw new Error('Invalid flight text')
      const hex = bytes.subarray(offset + 1, comma).toString('ascii')
      if (!/^[a-f0-9]{1,8}$/i.test(hex)) throw new Error('Invalid flight text length')
      const length = Number.parseInt(hex, 16)
      offset = comma + 1
      if (length > bytes.length - offset) throw new Error('Incomplete flight text')
      rows.set(id, new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)))
      offset += length
    } else {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      const raw = bytes.subarray(offset, end).toString('utf8')
      // Import/hint/debug records are not room data and must not be interpreted as code.
      try { rows.set(id, JSON.parse(raw) as unknown) } catch { /* Non-model record. */ }
      offset = end + 1
    }
  }
  return rows
}

export function parseDouyinPage(html: string, expectedWebRoom?: string): DouyinRoomData | null {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_PLATFORM_RESPONSE_BYTES) return null
  try {
    const chunks: string[] = []
    const reflow: string[] = []
    const legacy: unknown[] = []
    let count = 0
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (++count > MAX_ROWS) return null
      const body = script[2]!.trim()
      const call = /^self\.__(pace|rsc)_f\.push\(([\s\S]*)\)\s*;?$/.exec(body)
      if (call) {
        let frame: unknown
        try { frame = JSON.parse(call[2]!) as unknown } catch { continue }
        if (Array.isArray(frame) && frame.length === 2 && typeof frame[1] === 'string') {
          if (call[1] === 'pace' && frame[0] === 1) chunks.push(frame[1])
          else if (call[1] === 'rsc') reflow.push(frame[1])
        }
      } else if (/\bid\s*=\s*["']RENDER_DATA["']/i.test(script[1]!)) {
        try { legacy.push(JSON.parse(decodeURIComponent(body)) as unknown) } catch { /* Invalid legacy JSON. */ }
      }
    }
    const rows = flightRows(chunks)
    if (reflow.length) {
      try { legacy.push(JSON.parse(reflow.join('')) as unknown) }
      catch { for (const [id, value] of flightRows(reflow)) rows.set(id, value) }
    }
    for (const [index, value] of legacy.entries()) rows.set(`legacy-${index}`, value)
    return new Models(rows).room(expectedWebRoom)
  } catch { return null }
}

/** Only the fields consumed by the live resolver cross the mobile/web shape boundary. */
export function normalizeDouyinStream(raw: unknown): JsonRecord {
  const stream = asRecord(raw)
  if (stream.live_core_sdk_data || stream.flv_pull_url || stream.hls_pull_url_map) return stream
  const sdk = asRecord(stream.liveCoreSdkData)
  const pull = asRecord(sdk.pullData)
  const options = asRecord(pull.options)
  return { flv_pull_url: stream.flvPullUrl, hls_pull_url_map: stream.hlsPullUrlMap,
    live_core_sdk_data: { pull_data: { stream_data: pull.streamData, options: {
      ...options, qualities: Array.isArray(options.qualities) ? options.qualities.map(raw => {
        const item = asRecord(raw)
        return { ...item, sdk_key: item.sdkKey, frame_rate: item.frameRate }
      }) : undefined,
    } } } }
}

/** The web entry API uses string ids because room ids exceed JavaScript's safe range. */
export function parseDouyinWebResponse(raw: unknown, webRoom: string): DouyinRoomData | null {
  const payload = asRecord(raw)
  const data = asRecord(payload.data)
  if (payload.status_code !== 0 || !Array.isArray(data.data) || data.data.length !== 1) return null
  const room = asRecord(data.data[0])
  if (!Object.hasOwn(room, 'status')) return null
  return { webRoom, roomId: douyinId(room.id_str) ?? douyinId(data.enter_room_id), status: room.status,
    title: room.title, stream: asRecord(room.stream_url), h264: {} }
}
