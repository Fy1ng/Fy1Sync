/** Local A-Bogus port of F2, Apache-2.0. See fixtures/f2-NOTICE.txt.
 * Source pinned at f6be8c0ffba9a127075bbeafe4838716650b6325.
 * No browser runtime, remote signing service or downloaded code is executed.
 */
import { randomInt } from 'node:crypto'

const ALPHABET = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe'
const UA_ALPHABET = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe'
const STATE = [121,243,55,234,103,36,47,228,30,231,106,6,115,95,78,101,250,207,198,50,139,227,220,105,97,143,34,28,194,215,18,100,159,160,43,8,169,217,180,120,247,45,90,11,27,197,46,3,84,72,5,68,62,56,221,75,144,79,73,161,178,81,64,187,134,117,186,118,16,241,130,71,89,147,122,129,65,40,88,150,110,219,199,255,181,254,48,4,195,248,208,32,116,167,69,201,17,124,125,104,96,83,80,127,236,108,154,126,204,15,20,135,112,158,13,1,188,164,210,237,222,98,212,77,253,42,170,202,26,22,29,182,251,10,173,152,58,138,54,141,185,33,157,31,252,132,233,235,102,196,191,223,240,148,39,123,92,82,128,109,57,24,38,113,209,245,2,119,153,229,189,214,230,174,232,63,52,205,86,140,66,175,111,171,246,133,238,193,99,60,74,91,225,51,76,37,145,211,166,151,213,206,0,200,244,176,218,44,184,172,49,216,93,168,53,21,183,41,67,85,224,155,226,242,87,177,146,70,190,12,162,19,137,114,25,165,163,192,23,59,9,94,179,107,35,7,142,131,239,203,149,136,61,249,14,156]
const ORDER = [18,20,52,26,30,34,58,38,40,53,42,21,27,54,55,31,35,57,39,41,43,22,28,32,60,36,23,29,33,37,44,45,59,46,47,48,49,50,24,25,65,66,70,71]
const FINGERPRINT = '1920|1080|1920|1080|0|0|0|0|1920|1080|1920|1080|1920|1080|24|24|Win32'
const rotate = (n: number, count: number) => (n << (count & 31)) | (n >>> ((32 - count) & 31))

/** SM3 stays portable to Electron builds whose crypto provider lacks SM3. */
export function douyinSm3(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input); padded[input.length] = 128
  const view = new DataView(padded.buffer)
  view.setBigUint64(padded.length - 8, BigInt(input.length) * 8n)
  const hash = [0x7380166f,0x4914b2b9,0x172442d7,0xda8a0600,0xa96f30bc,0x163138aa,0xe38dee4d,0xb0fb0e4e]
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Int32Array(68)
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4)
    for (let i = 16; i < 68; i++) {
      const x = words[i - 16]! ^ words[i - 9]! ^ rotate(words[i - 3]!, 15)
      words[i] = x ^ rotate(x, 15) ^ rotate(x, 23) ^ rotate(words[i - 13]!, 7) ^ words[i - 6]!
    }
    let [a,b,c,d,e,f,g,h] = hash as [number,number,number,number,number,number,number,number]
    for (let i = 0; i < 64; i++) {
      const ss1 = rotate((rotate(a, 12) + e + rotate(i < 16 ? 0x79cc4519 : 0x7a879d8a, i)) | 0, 7)
      const ss2 = ss1 ^ rotate(a, 12)
      const ff = i < 16 ? a ^ b ^ c : (a & b) | (a & c) | (b & c)
      const gg = i < 16 ? e ^ f ^ g : (e & f) | (~e & g)
      const tt1 = (ff + d + ss2 + (words[i]! ^ words[i + 4]!)) | 0
      const tt2 = (gg + h + ss1 + words[i]!) | 0
      d = c; c = rotate(b, 9); b = a; a = tt1
      h = g; g = rotate(f, 19); f = e; e = tt2 ^ rotate(tt2, 9) ^ rotate(tt2, 17)
    }
    ;[a,b,c,d,e,f,g,h].forEach((value, i) => { hash[i] = hash[i]! ^ value })
  }
  const result = new Uint8Array(32), output = new DataView(result.buffer)
  hash.forEach((value, i) => output.setInt32(i * 4, value))
  return result
}

function encode(bytes: Uint8Array, alphabet: string): string {
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  return Buffer.from(bytes).toString('base64').replace(/[A-Za-z0-9+/]/g, value => alphabet[standard.indexOf(value)]!)
}
function uaBytes(value: string): Uint8Array {
  const state = Array.from({ length: 256 }, (_, i) => i), key = [0,1,14]
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % 3]!) & 255; [state[i],state[j]] = [state[j]!,state[i]!] }
  j = 0; let i = 0
  return Uint8Array.from(Buffer.from(value, 'ascii'), byte => {
    i = (i + 1) & 255; j = (j + state[i]!) & 255; [state[i],state[j]] = [state[j]!,state[i]!]
    return byte ^ state[(state[i]! + state[j]!) & 255]!
  })
}

export interface DouyinHttpSignerValues { start: number; end: number; random: readonly [number, number, number] }

/** Sign the exact already-encoded query bytes sent on the wire, excluding a_bogus. */
export function signDouyinHttpQuery(query: string, userAgent: string, values?: DouyinHttpSignerValues): string {
  if (typeof query !== 'string' || !query || query.length > 16_384 || /[^\x21-\x7e]/.test(query)
    || /(?:^|&)a_bogus=/.test(query) || !userAgent || userAgent.length > 512 || /[^\x20-\x7e]/.test(userAgent)) throw new Error('Invalid HTTP signing input')
  const start = values?.start ?? Date.now()
  const digest = (value: string) => douyinSm3(douyinSm3(Buffer.from(value + 'cus')))
  const params = digest(query), body = digest('')
  const ua = douyinSm3(Buffer.from(encode(uaBytes(userAgent), UA_ALPHABET)))
  const end = values?.end ?? Date.now()
  const random = values?.random ?? [randomInt(10000),randomInt(10000),randomInt(10000)]
  if (![start,end].every(value => Number.isSafeInteger(value) && value >= 0 && value < 2 ** 48) || end < start
    || random.length !== 3 || random.some(value => !Number.isInteger(value) || value < 0 || value >= 10000)) throw new Error('Invalid HTTP signing entropy')
  const fields: Record<number, number> = { 18:44, 31:1, 37:14, 38:params[21]!, 39:params[22]!, 40:body[21]!, 41:body[22]!, 42:ua[23]!, 43:ua[24]!, 48:3, 57:6383 & 255, 58:6383 >>> 8, 65:FINGERPRINT.length }
  for (let i = 0; i < 4; i++) { fields[20 + i] = Math.floor(start / 2 ** ((3 - i) * 8)) & 255; fields[44 + i] = Math.floor(end / 2 ** ((3 - i) * 8)) & 255 }
  fields[24] = Math.floor(start / 2 ** 32); fields[25] = Math.floor(start / 2 ** 40)
  fields[49] = Math.floor(end / 2 ** 32); fields[50] = Math.floor(end / 2 ** 40)
  const bytes = ORDER.map(id => fields[id] ?? 0)
  const checksum = bytes.reduce((value, byte) => value ^ byte, 0)
  bytes.push(...Buffer.from(FINGERPRINT), checksum)
  const state = [...STATE], encrypted: number[] = []
  let index = state[1]!, initial = 0, next = 0
  bytes.forEach((byte, offset) => {
    let sum: number
    if (!offset) { initial = state[index]!; sum = index + initial; state[1] = initial; state[index] = index }
    else sum = initial + next
    encrypted.push(byte ^ state[sum & 255]!)
    next = state[(offset + 2) & 255]!
    const swapped = (index + next) & 255
    initial = state[swapped]!
    state[swapped] = state[(offset + 2) & 255]!; state[(offset + 2) & 255] = initial; index = swapped
  })
  const prefix = random.flatMap(n => [(n & 255 & 170) | 1, (n & 255 & 85) | 2, ((n >>> 8) & 170) | 5, ((n >>> 8) & 85) | 40])
  return encode(Uint8Array.from([...prefix,...encrypted]), ALPHABET)
}
