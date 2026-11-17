import { inspect } from 'node:util'
import { constants, createDecipheriv, createCipheriv, publicEncrypt } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import profile from './fixtures/passport-dtrait-profile.json'
import { DouyinPassportDtrait } from './passportDtrait'

const observed = vi.hoisted(() => ({ keyCopies:[] as Buffer[],keyRefs:[] as Buffer[],textRefs:[] as Buffer[] }))
vi.mock('node:crypto',async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    publicEncrypt:vi.fn((...args:Parameters<typeof actual.publicEncrypt>) => {
      const input = args[1] as Buffer
      observed.keyCopies.push(Buffer.from(input.toString('ascii'),'hex'))
      observed.textRefs.push(input)
      return actual.publicEncrypt(...args)
    }),
    createCipheriv:vi.fn((...args:Parameters<typeof actual.createCipheriv>) => {
      observed.keyRefs.push(args[1] as Buffer)
      return actual.createCipheriv(...args)
    }),
  }
})

const NOW = 1790000000123
const CHECK_PATH = '/passport/web/check_qrconnect/'
const CREATE_PATH = '/passport/web/get_qrcode/'

// Pinned catbus independent Python-generated dtrait_blob.json. Compare derived
// records; the current public profile has separately updated historical rendering hashes.
const REFERENCE_BLOB = 'IAAAAADQIC0FVqIh4kBm/yLQO48ZI0f7Q3wkUnQhRSUtc6pZJoXtgvcnqvUbwih5/ufyKR3SnsMqMtFjyisa3jq/LEbrp0It3oooWy6x8OwMLzYf+ukwKpioVDEAAAAAMg10HEszi/GgODQpsnJ0NRJqRnA2hZHFNjcbzZ0NOFhf5lQ5ucywezqnDTbrO0LJZ588JQFrBT3os+69Pnc1cw4/6hH+lkBcuWKWRwEp4hc='

function records(blob: string): Map<number,number> {
  const bytes = Buffer.from(blob,'base64')
  expect(bytes.length).toBe(176)
  expect(bytes[0]).toBe(32)
  const result = new Map<number,number>()
  for (let at = 6; at < bytes.length; at += 5) result.set(bytes[at]!,bytes.readUInt32BE(at + 1))
  return result
}

function decrypt(header: string,key: Buffer): { dtrait:string; timestamp:number; sdkVersion:string; path:string } {
  const parts = header.split('_')
  expect(parts).toHaveLength(3)
  expect(parts[0]).toBe('d0')
  expect(Buffer.from(parts[1]!,'base64')).toHaveLength(256)
  const bytes = Buffer.from(parts[2]!,'base64')
  const decipher = createDecipheriv('aes-128-cbc',key,bytes.subarray(0,16))
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)),decipher.final()]).toString('utf8'))
}

beforeEach(() => {
  vi.clearAllMocks()
  observed.keyCopies = []; observed.keyRefs = []; observed.textRefs = []
})
afterEach(() => { for (const key of observed.keyCopies) key.fill(0) })

describe('Douyin passport dtrait session', () => {
  it('encrypts the SDK payload with fresh IVs and reuses only the session key', () => {
    const session = new DouyinPassportDtrait({ now:() => NOW })
    try {
      const first = session.header(CREATE_PATH),second = session.header(CHECK_PATH),third = session.header(CHECK_PATH)
      expect(vi.mocked(publicEncrypt)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(publicEncrypt).mock.calls[0]![0]).toMatchObject({ padding:constants.RSA_PKCS1_PADDING })
      const key = observed.keyCopies[0]!
      expect(key).toHaveLength(16)
      expect(observed.textRefs[0]!.every(byte => byte === 0)).toBe(true)
      expect(first.split('_')[1]).toBe(second.split('_')[1])
      expect(second).not.toBe(third)
      const iv = (header: string) => Buffer.from(header.split('_')[2]!,'base64').subarray(0,16).toString('hex')
      expect(new Set([iv(first),iv(second),iv(third)]).size).toBe(3)
      expect(decrypt(first,key)).toMatchObject({ timestamp:Math.floor(NOW / 1000),sdkVersion:'1.0.0.16',path:CREATE_PATH })
      expect(decrypt(second,key)).toMatchObject({ timestamp:Math.floor(NOW / 1000),sdkVersion:'1.0.0.16',path:CHECK_PATH })
      expect(Object.keys(decrypt(first,key))).toEqual(['dtrait','timestamp','sdkVersion','path'])
      expect(vi.mocked(createCipheriv)).toHaveBeenCalledTimes(3)
    } finally { session.dispose() }
  })

  it('matches independent reference-derived features and preserves the attributed public rendering hashes', () => {
    const session = new DouyinPassportDtrait({ now:() => NOW })
    try {
      const payload = decrypt(session.header(CHECK_PATH),observed.keyCopies[0]!)
      const actual = records(payload.dtrait),reference = records(REFERENCE_BLOB)
      for (const index of [11,12,14,15,16,17,18,19,27,28,29,30,31,32]) expect(actual.get(31 + index)).toBe(reference.get(31 + index))
      for (const [index,value] of Object.entries(profile.render_hashes)) expect(actual.get(Number(index) <= 33 ? 31 + Number(index) : 71)).toBe(value)
    } finally { session.dispose() }
  })

  it('updates the UA-derived feature without mutating the shared public profile', () => {
    const original = new DouyinPassportDtrait({ now:() => NOW })
    const ua = profile.ua.replace('155.0.0.0','156.0.0.0')
    const other = new DouyinPassportDtrait({ userAgent:ua,now:() => NOW })
    try {
      const first = records(decrypt(original.header(CHECK_PATH),observed.keyCopies[0]!).dtrait)
      const second = records(decrypt(other.header(CHECK_PATH),observed.keyCopies[1]!).dtrait)
      expect(other.userAgent).toBe(ua)
      expect(first.get(50)).not.toBe(second.get(50))
      first.delete(50); second.delete(50)
      expect(second).toEqual(first)
      expect(profile.ua).toContain('Chrome/155.0.0.0')
    } finally { original.dispose(); other.dispose() }
  })

  it('keeps generated key material private and clears retained buffers on disposal', () => {
    const session = new DouyinPassportDtrait({ now:() => NOW })
    session.header(CHECK_PATH)
    const secret = observed.keyCopies[0]!.toString('hex')
    expect(JSON.stringify(session)).toBe(JSON.stringify({ userAgent:profile.ua }))
    expect(inspect(session,{ showHidden:true })).not.toContain(secret)
    expect(Object.keys(session)).toEqual(['userAgent'])
    expect(observed.keyRefs[0]!.some(byte => byte !== 0)).toBe(true)
    session.dispose()
    expect(observed.keyRefs[0]!.every(byte => byte === 0)).toBe(true)
    expect(() => session.header(CHECK_PATH)).toThrow('抖音设备保护会话已释放')
    expect(() => session.dispose()).not.toThrow()
  })

  it('rejects malformed paths and invalid clocks before encryption', () => {
    const session = new DouyinPassportDtrait({ now:() => NOW })
    try {
      for (const path of ['https://login.douyin.com/passport/web/check_qrconnect/','//other/path','/path?token=secret','/path#hash','/path\n']) expect(() => session.header(path)).toThrow()
      expect(vi.mocked(createCipheriv)).not.toHaveBeenCalled()
    } finally { session.dispose() }
    const badClock = new DouyinPassportDtrait({ now:() => NaN })
    try { expect(() => badClock.header(CHECK_PATH)).toThrow('抖音设备保护时间无效') }
    finally { badClock.dispose() }
    expect(() => new DouyinPassportDtrait({ userAgent:'\n' })).toThrow()
  })
})
