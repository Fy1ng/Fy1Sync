import { validDouyuRoom } from '../platforms/douyuRoom'

export interface DouyuRoomStatus { live: boolean | null; replay: boolean | null }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const binary = (value: unknown): boolean | null => value === 1 || value === '1' ? true : value === 0 || value === '0' ? false : null

/** The PC page's room object owns both status flags. Similar fields in recommendation cards do not. */
export function parseDouyuRoomStatus(room: unknown, expectedRoom: string): DouyuRoomStatus | null {
  const data = object(room)
  if (!data || validDouyuRoom(data.room_id) !== expectedRoom || (data.rid !== undefined && validDouyuRoom(data.rid) !== expectedRoom)) return null
  const flags = [data.videoLoop, data.video_loop, data.is_loop, object(data.room_biz_all)?.videoLoop]
    .filter(value => value !== undefined)
  const parsed = flags.map(binary)
  const replay = parsed.length && parsed.every(value => value !== null && value === parsed[0]) ? parsed[0]! : null
  return { live: data.show_status === 1 || data.show_status === '1' ? true
    : [0, 2, '0', '2'].includes(data.show_status as number | string) ? false : null, replay }
}

/** Only JSON data from Next's streamed page records is decoded; script text is never executed. */
export function parseDouyuPcRoomStatus(page: string, expectedRoom: string): DouyuRoomStatus | null {
  if (!validDouyuRoom(expectedRoom) || Buffer.byteLength(page) > 2 * 1_048_576) return null
  let records = ''
  for (const script of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    for (const push of script[1]!.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
      try { records += JSON.parse(push[1]!) as string } catch { return null }
      if (records.length > 2 * 1_048_576) return null
    }
  }
  let found: DouyuRoomStatus | null = null
  let visited = 0
  for (const line of records.split('\n')) {
    const match = /^[0-9a-f]+:J?([\[{].*)$/i.exec(line)
    if (!match) continue
    let root: unknown
    try { root = JSON.parse(match[1]!) } catch { continue }
    const pending: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }]
    while (pending.length) {
      const { value, depth } = pending.pop()!
      if (++visited > 10_000 || depth > 32) return null
      const record = object(value)
      if (record && Object.hasOwn(record, 'roomInfo')) {
        const candidate = parseDouyuRoomStatus(object(record.roomInfo)?.room, expectedRoom)
        if (candidate) {
          if (found && (found.live !== candidate.live || found.replay !== candidate.replay)) return null
          found = candidate
        }
      }
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) if (child !== null && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
      }
    }
  }
  return found
}
