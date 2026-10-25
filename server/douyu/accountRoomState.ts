import { parseMessagePayload, unsigned, type GatewayMessage } from './messageProtocol'

export interface DouyuAccountRoomState {
  accountId: string
  room: string
  uid: string
  checkedAt: number
  balance: { gold: number | null; silver: number | null }
  fanEligible: boolean | null
  source: 'authenticated-blst-gbi'
}
export interface AccountInspection {
  want: 'balance' | 'fan'
  complete: boolean
  value: DouyuAccountRoomState
  receivedBalance: boolean
  receivedFan: boolean
}

/** Only called after this connection's authenticated login, with its confirmed identity. */
export function observeAccountRoom(inspection: AccountInspection, message: GatewayMessage): void {
  const value = inspection.value
  if (['uid', 'userid', 'sender'].some(key => message[key] !== undefined && message[key] !== value.uid)
    || ['rid', 'roomid'].some(key => message[key] !== undefined && message[key] !== value.room)) return
  if (message.type === 'memberinfores') {
    inspection.receivedBalance = true
    value.balance = { gold: unsigned(message.gold, Number.MAX_SAFE_INTEGER), silver: unsigned(message.silver, Number.MAX_SAFE_INTEGER) }
  } else if (message.type === 'blst' && Object.hasOwn(message, 'list')) {
    value.fanEligible = fanMembership(message.list, value.room)
    inspection.receivedFan = true
  } else if (message.type === 'gbi' && unsigned(message.bl, 1_000) !== null) {
    value.fanEligible = true
    inspection.receivedFan = true
  }
}

function fanMembership(encoded: unknown, room: string): boolean | null {
  if (typeof encoded !== 'string' || encoded.length > 262_144) return null
  if (encoded === '') return false
  if (!encoded.endsWith('/')) return null
  const rows = encoded.slice(0, -1).split('/')
  if (rows.length > 1_000) return null
  const seen = new Set<string>()
  let found = false
  try {
    for (const row of rows) {
      if (/@(?![AS])/.test(row)) return null
      const badge = parseMessagePayload('type@=badge/' + row.replace(/@S/g, '/').replace(/@A/g, '@'))
      if (!badge.rid || !/^[1-9][0-9]{0,11}$/.test(badge.rid) || seen.has(badge.rid)
        || unsigned(badge.bl, 1_000) === null) return null
      seen.add(badge.rid)
      if (badge.rid === room) found = true
    }
  } catch { return null }
  // Presence in blst is affirmative evidence; an absent room is not an exhaustive census.
  return found ? true : null
}
