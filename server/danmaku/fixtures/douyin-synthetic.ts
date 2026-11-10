/** Fabricated room, account and wire values; never captured live chat. */
import { gzipSync } from 'node:zlib'
import { douyinProtoField as field } from '../douyinProtocol'

export const syntheticDouyinIds = { webRoom: '100', roomId: '9000000000000000001', userUniqueId: '9000000000000000002', messageId: '18446744073709551613', logId: '18446744073709551614' }
export const joinDouyinBytes = (...values: Uint8Array[]): Uint8Array<ArrayBuffer> => Uint8Array.from(values.flatMap(value => [...value]))
export function syntheticDouyinChat(options: { roomId?: string; messageId?: string; text?: string; username?: string; duplicateContent?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const common = joinDouyinBytes(field(2, BigInt(options.messageId ?? syntheticDouyinIds.messageId)), field(3, BigInt(options.roomId ?? syntheticDouyinIds.roomId)))
  const user = joinDouyinBytes(field(1, 9000000000000000099n), field(3, options.username ?? 'synthetic-viewer'), field(5, 'synthetic-private-profile'))
  const chat = joinDouyinBytes(field(1, common), field(2, user), field(3, options.text ?? 'synthetic-chat'), ...(options.duplicateContent ? [field(3, 'duplicate')] : []))
  return joinDouyinBytes(field(1, 'WebcastChatMessage'), field(2, chat), field(3, BigInt(syntheticDouyinIds.messageId)))
}
export function syntheticDouyinResponse(messages: Uint8Array[] = [syntheticDouyinChat()]): Uint8Array<ArrayBuffer> {
  return joinDouyinBytes(...messages.map(value => field(1, value)), field(2, 'synthetic-cursor'), field(5, 'synthetic-internal'), field(8, 15n), field(9, 1n), field(14, 'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/'))
}
export function syntheticDouyinFrame(options: { messages?: Uint8Array[]; compressed?: boolean; payload?: Uint8Array; encoding?: string; duplicateHeader?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const response = options.payload ?? syntheticDouyinResponse(options.messages)
  const compressed = options.compressed ?? true
  const compressHeader = field(5, joinDouyinBytes(field(1, 'compress_type'), field(2, compressed ? 'gzip' : 'none')))
  return joinDouyinBytes(field(2, BigInt(syntheticDouyinIds.logId)), compressHeader, ...(options.duplicateHeader ? [compressHeader] : []),
    field(5, joinDouyinBytes(field(1, 'im-internal_ext'), field(2, 'synthetic-header-internal'))), field(6, options.encoding ?? 'pb'), field(7, 'msg'), field(8, compressed ? gzipSync(response) : response))
}
export function syntheticDouyinPage(): string {
  const state = { roomStore: { roomInfo: { web_rid: syntheticDouyinIds.webRoom, roomId: syntheticDouyinIds.roomId, room: { status: 2, stream_url: {} } } } }
  const data = ['$', 'div', null, { state, user_unique_id: syntheticDouyinIds.userUniqueId }]
  return `<script>self.__pace_f.push(${JSON.stringify([1, `0:${JSON.stringify(data)}\n`])});</script>`
}
