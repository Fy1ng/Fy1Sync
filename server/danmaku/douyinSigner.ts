/** Compact local handshake signer ported from jwwsjlm/douyinLive (MIT).
 * Source and full notice: fixtures/douyin-LICENSE.txt. No downloaded code is executed.
 */
import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe'
const md5 = (bytes: Uint8Array | string): Buffer => createHash('md5').update(bytes).digest()
const EMPTY = md5(md5(Buffer.alloc(0)))
const id = (value: string): void => { if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) throw new Error('Invalid signing identity') }

export function douyinSigningStub(roomId: string, userUniqueId: string, sdkVersion = '1.0.15'): string {
  id(roomId); id(userUniqueId)
  if (!/^1\.0\.(?:14-beta\.0|15)$/.test(sdkVersion)) throw new Error('Invalid SDK version')
  return md5(`live_id=1,aid=6383,version_code=180800,webcast_sdk_version=${sdkVersion},room_id=${roomId},sub_room_id=,sub_channel_id=,did_rule=3,user_unique_id=${userUniqueId},device_platform=web,device_type=,ac=,identity=audience`).toString('hex')
}

/** Explicit values support deterministic upstream golden vectors. */
export function douyinSignatureWithValues(stub: string, counter: number, flag: boolean, payloadRandom: number, keyRandom: number): string {
  if (!/^[a-f0-9]{32}$/i.test(stub) || ![counter, payloadRandom, keyRandom].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error('Invalid signer input')
  const digest = md5(Buffer.from(stub, 'hex'))
  const payload = Uint8Array.from([counter & 63, 0, 1, 14, EMPTY[14]!, EMPTY[15]!, digest[14]!, digest[15]!, payloadRandom, 0])
  for (let index = 0; index < 9; index++) payload[9] = payload[9]! ^ payload[index]!
  // RC4 is required by the upstream wire format, not used for local credential encryption.
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + keyRandom) & 255; const value = state[i]!; state[i] = state[j]!; state[j] = value }
  let i = 0; j = 0
  const result = Uint8Array.from([64 | (flag ? 16 : 0), keyRandom, ...payload])
  for (let index = 2; index < result.length; index++) { i = (i + 1) & 255; j = (j + state[i]!) & 255; const value = state[i]!; state[i] = state[j]!; state[j] = value; result[index] = result[index]! ^ state[(state[i]! + state[j]!) & 255]! }
  let encoded = ''
  for (let offset = 0; offset < result.length; offset += 3) { const value = (result[offset]! << 16) | (result[offset + 1]! << 8) | result[offset + 2]!; encoded += ALPHABET[(value >>> 18) & 63]! + ALPHABET[(value >>> 12) & 63]! + ALPHABET[(value >>> 6) & 63]! + ALPHABET[value & 63]! }
  return encoded
}

export class DouyinSigner {
  private counter = 0
  constructor(private readonly randomByte: () => number = () => randomBytes(1)[0]!) {}
  private random(excludeFF: boolean): number {
    for (let attempts = 0; attempts < 256; attempts++) { const value = this.randomByte(); if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid random source'); if (!excludeFF || value !== 255) return value }
    throw new Error('Invalid random source')
  }
  sign(roomId: string, userUniqueId: string): string { const flag = this.random(false) & 1; this.counter = (this.counter + 1) & 63; return douyinSignatureWithValues(douyinSigningStub(roomId, userUniqueId), this.counter, !!flag, this.random(true), this.random(true)) }
}
