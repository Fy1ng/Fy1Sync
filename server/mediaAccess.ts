import { isIP } from 'node:net'

/** One explicit source authorizes its origin, never every private service in a playlist. */
export class MediaAccessScope {
  readonly origin: string
  private localOrigin: boolean | undefined

  constructor(raw: string) { this.origin = new URL(raw).origin }

  permits(url: URL, addresses: readonly string[], entry: boolean, commit = true): boolean {
    const local = localMediaHost(url.hostname) || addresses.some(localMediaAddress)
    if (entry && url.origin === this.origin && this.localOrigin === undefined) {
      if (commit) this.localOrigin = local
      return true
    }
    // A source first reached publicly cannot rebind into the local network later.
    if (url.origin === this.origin && this.localOrigin === true) return true
    return !local
  }
}

export interface MediaAccess { scope: MediaAccessScope; entry: boolean }
export const mediaEntry = (raw: string): MediaAccess => ({ scope: new MediaAccessScope(raw), entry: true })
export const mediaChild = (parent: MediaAccess): MediaAccess => ({ scope: parent.scope, entry: false })

export function localMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(host)) return localMediaAddress(host)
  return !host.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|home|lan|home\.arpa)$/.test(host)
}

/** Fake-IP ranges such as 198.18/15 are not evidence of a local target. */
export function localMediaAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
      || (a === 100 && b! >= 64 && b! <= 127)
  }
  if (isIP(address) !== 6) return false
  const words = ipv6Words(address)
  if (!words) return true
  const [first] = words
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    if (words[5] === 0 && words[6] === 0 && words[7]! <= 1) return true
    return localMediaAddress(`${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`)
  }
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every(word => word === 0)) {
    return localMediaAddress(`${words[6]! >>> 8}.${words[6]! & 255}.${words[7]! >>> 8}.${words[7]! & 255}`)
  }
  return (first! & 0xfe00) === 0xfc00 || (first! & 0xffc0) === 0xfe80
    || (first! & 0xffc0) === 0xfec0 || (first! & 0xff00) === 0xff00
}

function ipv6Words(address: string): number[] | undefined {
  let value = address
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':')
    const bytes = value.slice(colon + 1).split('.').map(Number)
    if (bytes.length !== 4) return undefined
    value = value.slice(0, colon + 1) + ((bytes[0]! << 8) | bytes[1]!).toString(16) + ':' + ((bytes[2]! << 8) | bytes[3]!).toString(16)
  }
  const halves = value.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return parts.length === 8 ? parts.map(part => Number.parseInt(part, 16)) : undefined
}
