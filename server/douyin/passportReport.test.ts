import { describe, expect, it } from 'vitest'
import profile from './fixtures/passport-dtrait-profile.json'
import { createDouyinPassportReport, encodeDouyinPassportReport } from './passportReport'

const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const ALPHABET = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe'
function decodeWire(value: string): Buffer { return Buffer.from(value.replace(/[A-Za-z0-9+/]/g, char => STANDARD[ALPHABET.indexOf(char)]!), 'base64') }
function unpack(value: string): Record<string, any> {
  const wire = decodeWire(value), key = wire[1]!, state = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key) % 256; [state[i],state[j]] = [state[j]!,state[i]!] }
  let i = 0; j = 0
  const plaintext = wire.subarray(2).map(byte => { i = (i + 1) % 256; j = (j + state[i]!) % 256; [state[i],state[j]] = [state[j]!,state[i]!]; return byte ^ state[(state[i]! + state[j]!) % 256]! })
  return JSON.parse(Buffer.from(plaintext).toString('utf8'))
}

describe('anonymous passport device reports', () => {
  it('uses the standard RC4 zero-key stream rather than the A-Bogus variant', () => {
    expect(decodeWire(encodeDouyinPassportReport('\0'.repeat(16), 0)).toString('hex')).toBe('4100de188941a3375d3a8a061e67576e926d')
  })

  it.each(['initial','sms'] as const)('binds %s reports to the HTTP identity, fresh time and caller-owned UUID without account fields', kind => {
    const ua = profile.ua.replace('155.0.0.0','156.0.0.0'), now = 1790000000123, uuid = '12345678-1234-1234-1234-123456789012'
    const wire = JSON.parse(createDouyinPassportReport(kind, { userAgent: ua, now, nonce: 27, uuid }))
    const payload = unpack(wire.strData)
    expect(wire).toMatchObject({ magic:538969122,version:1,dataType:8,tspFromClient:now + (kind === 'sms' ? 11 : 0) })
    expect(payload.nWID.navigator).toMatchObject({ userAgent:ua,hardwareConcurrency:profile.hardware_concurrency })
    expect(JSON.parse(payload.nWID.custom)).toMatchObject({ uuid })
    expect(payload.nWID.screen).toMatchObject({ width:profile.screen_width,height:profile.screen_height,availHeight:profile.avail_height })
    for (const key of ['mobile','password','sessionid','sessionid_ss','ticket','room_id']) expect(payload).not.toHaveProperty(key)
    if (kind === 'sms') {
      expect(payload.wID).toMatchObject({ msgType:1,aid:6383,pageId:6241,timestamp:String(now) })
      expect(payload.navigator.appVersion).toBe(ua.replace(/^Mozilla\//,''))
      expect(payload.ubCode).toBe(12)
      expect(payload.nWID.ubCode).toBe(12)
    }
  })

  it('creates new report identifiers while keeping immutable public profiles and rejecting invalid codec input', () => {
    const first = JSON.parse(createDouyinPassportReport('sms', { userAgent:profile.ua }))
    const second = JSON.parse(createDouyinPassportReport('sms', { userAgent:profile.ua }))
    expect(JSON.parse(unpack(first.strData).nWID.custom).uuid).not.toBe(JSON.parse(unpack(second.strData).nWID.custom).uuid)
    for (const nonce of [-1,256,0.5,NaN]) expect(() => encodeDouyinPassportReport('example',nonce)).toThrow()
    expect(() => encodeDouyinPassportReport('x'.repeat(65537),0)).toThrow()
    expect(() => createDouyinPassportReport('sms', { userAgent:'PRIVATE\nHEADER' })).toThrow()
  })
})
