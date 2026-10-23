import { describe, expect, it } from 'vitest'
import { encodeFrame, escapeStt, serializeStt } from '../danmaku/douyuProtocol'
import {
  gatewayAddress, MAX_BUFFER_BYTES, MAX_FRAME_BYTES, MAX_TOTAL_BYTES, MessageFrameDecoder,
  messageChallenge, messageColorPalette, messageCredentials, messageSigningKeys, normalizeMessageText,
  parseMessagePayload, receiptMatch, signMessageGateway, type GatewayMessage,
} from './messageProtocol'

// Synthetic data only. These tests never contact Douyu or read browser cookies.
const cookie = `acf_uid=42; acf_did=${'1'.repeat(32)}; acf_username=fixture-user; acf_auth_wl=fixture-auth`
const keyPayload = {
  error: 0, data: { rand_str: 'fixture-challenge', enc_time: 1, cpp: {
    danmu: { key: 'fixture-login-key', key_ver: '1.0' },
    heartbeat: { key: 'fixture-heartbeat-key', key_ver: '1.1' },
  } },
}
const serverFrame = (fields: Record<string, string | number>) => encodeFrame(serializeStt(fields), 690)

describe('message text and credential boundaries', () => {
  it.each(['', '   ', 'x'.repeat(501), 'a\nb', 'a\tb', '\u007f', '\u0085', '\u2028', '\ud800', '\udc00', '\ud800x'])('rejects invalid text %#', value => {
    expect(normalizeMessageText(value)).toBeNull()
  })
  it('normalizes actual transmitted text without losing UTF-16 boundaries', () => {
    expect(normalizeMessageText(' 中文 /@ \\ 😀 ')).toBe('中文 /@ \uff3c 😀')
    expect(normalizeMessageText('😀'.repeat(250))?.length).toBe(500)
    expect(normalizeMessageText('文'.repeat(500))?.length).toBe(500)
    expect(normalizeMessageText('😀'.repeat(251))).toBeNull()
  })
  it('extracts only the exact known credentials and decodes once', () => {
    const parsed = messageCredentials(`${cookie.replace('fixture-user', 'fixture%2Duser')}; unused=private-value`)
    expect(parsed).toMatchObject({ uid: '42', did: '1'.repeat(32), username: 'fixture-user', password: 'fixture-auth' })
    expect(JSON.stringify(parsed)).not.toContain('private-value')
  })
  it.each([
    '', `${cookie}; acf_uid=42`, `${cookie}; acf_auth_wl=other`, `${cookie}; did=${'1'.repeat(32)}`,
    cookie.replace('42', '0'), cookie.replace('42', '042'), cookie.replace('fixture-auth', '%zz'),
    cookie.replace('fixture-auth', '%0d%0aInjected'), cookie.replace('fixture-auth', 'null'),
    cookie.replace('fixture-user', ''), cookie.replace('1'.repeat(32), 'short-device'),
    `${cookie}\nSecret`, `${cookie}; extra=${'x'.repeat(32_768)}`,
  ])('rejects missing, ambiguous or malformed credentials %#', value => { expect(messageCredentials(value)).toBeNull() })
  it.each(['acf_uid', 'acf_did', 'acf_username', 'acf_auth_wl'])('does not invent missing %s', name => {
    expect(messageCredentials(cookie.split('; ').filter(part => !part.startsWith(`${name}=`)).join('; '))).toBeNull()
  })
  it('accepts only identifiable protocol authentication material', () => {
    const base = cookie.split('; ').filter(part => !part.startsWith('acf_auth_wl=')).join('; ')
    expect(messageCredentials(`${base}; acf_auth=unrelated-http-token`)).toBeNull()
    expect(messageCredentials(`${base}; acf_dmjwt_token=fixture.jwt.value`)?.jwt).toBe('fixture.jwt.value')
    expect(messageCredentials(`${base}; acf_biz=1; acf_stk=fixture-stk; acf_ltkid=9`)?.stk).toBe('fixture-stk')
    expect(messageCredentials(`${base}; acf_stk=fixture-stk`)).toBeNull()
  })
})

describe('documented gateway signing and address bounds', () => {
  it('matches fixed zero/one-iteration vectors and keeps the STT zero challenge', () => {
    const keys = messageSigningKeys(keyPayload)
    const zero = messageChallenge({ nonce: 'fixture-challenge', its: '0' })
    expect(zero.iterations).toBe(0)
    expect(signMessageGateway('login', keys, '6979222', '1'.repeat(32), 1_700_000_000, zero)).toEqual({ alg_ver: '1.0', key_ver: '1.0', sig: '53d868321572b07050f69f66af6f3587' })
    expect(signMessageGateway('heartbeat', keys, '6979222', '1'.repeat(32), 1_700_000_000, zero).sig).toBe('08a99fb97167648bf5c34f9b69971cd3')
    expect(signMessageGateway('login', keys, '6979222', '1'.repeat(32), 1_700_000_000).sig).toBe('2eeb6330b795c2371584f4a4808bfc6f')
    expect(signMessageGateway('heartbeat', keys, '6979222', '1'.repeat(32), 1_700_000_000).sig).toBe('900d84309dc8094d1522322cee24300f')
  })
  it.each(['', '-1', '1.5', '10001', 'Infinity', '1e3'])('rejects an invalid or excessive signing iteration count %s', its => {
    expect(() => messageChallenge({ nonce: 'fixture-challenge', its })).toThrow('Unsupported')
  })
  it('rejects oversized nonces and incomplete key metadata', () => {
    expect(() => messageChallenge({ nonce: 'x'.repeat(513), its: '0' })).toThrow()
    expect(() => messageSigningKeys({ error: 0, data: {} })).toThrow()
    expect(() => messageSigningKeys({ ...keyPayload, error: 1 })).toThrow()
    expect(() => messageSigningKeys({ error: 0, data: { ...keyPayload.data, enc_time: 10_001 } })).toThrow()
  })
  it('accepts exactly the current published gateway and ports', () => {
    expect(gatewayAddress({ error: 0, data: { wss: [{ domain: 'wsproxy.douyu.com', port: 6671 }] } })).toBe('wss://wsproxy.douyu.com:6671/')
  })
  it.each([
    ['wsproxy.douyu.com.evil.example', 6671], ['127.0.0.1', 6671], ['[::1]', 6671],
    ['wsproxy.douyu.com@evil.example', 6671], ['wss://wsproxy.douyu.com', 6671],
    ['wsproxy.douyu.com/path', 6671], ['wsproxy.douyu.com', 80], ['wsproxy.douyu.com', 443],
    ['wsproxy.douyu.com', 6676], ['wsproxy.douyu.com', '06671'],
  ])('rejects injected gateway %s:%s', (domain, port) => {
    expect(() => gatewayAddress({ error: 0, data: { wss: [{ domain, port }] } })).toThrow()
  })
})

describe('strict server framing and receipt correlation', () => {
  it('handles partial and coalesced frames and nested STT escaping once', () => {
    const decoder = new MessageFrameDecoder()
    const first = serverFrame({ type: 'chatres', res: 288, txt: '中文 @/ 😀', list: 'x@=y/' })
    const next = serverFrame({ type: 'keeplive', tick: 1 })
    expect(decoder.feed(first.subarray(0, 3))).toEqual([])
    expect(decoder.feed(Buffer.concat([first.subarray(3), next]))).toEqual([
      { type: 'chatres', res: '288', txt: '中文 @/ 😀', list: 'x@=y/' }, { type: 'keeplive', tick: '1' },
    ])
  })
  it.each(['length', 'type', 'encryption', 'reserved', 'nul', 'utf8'])('rejects corrupt %s before trusting a receipt', part => {
    const frame = serverFrame({ type: 'chatres', res: 288 })
    if (part === 'length') frame.writeUInt32LE(1, 4)
    if (part === 'type') frame.writeUInt16LE(689, 8)
    if (part === 'encryption') frame[10] = 1
    if (part === 'reserved') frame[11] = 1
    if (part === 'nul') frame[frame.length - 1] = 1
    if (part === 'utf8') frame[12] = 0xff
    expect(() => new MessageFrameDecoder().feed(frame)).toThrow()
  })
  it.each([
    'type@=chatres/res@=288/res@=2/', 'type@=chatres/cst@=1/cst@=2/',
    'type@=chatres/txt@=bad@X/', 'type@=chatres/res@=288', 'type@=chatres//',
    'type@=chatres/txt@=a\0b/', 'res@=288/',
  ])('rejects ambiguous STT %#', payload => { expect(() => parseMessagePayload(payload)).toThrow() })
  it('bounds advertised frame size, incoming buffer size and total bytes', () => {
    const size = Buffer.alloc(4)
    size.writeUInt32LE(MAX_FRAME_BYTES)
    expect(() => new MessageFrameDecoder().feed(size)).toThrow()
    expect(() => new MessageFrameDecoder().feed(new Uint8Array(MAX_BUFFER_BYTES + 1))).toThrow()
    const frame = serverFrame({ type: 'ignored', body: 'x'.repeat(200_000) })
    const decoder = new MessageFrameDecoder()
    for (let index = 0; index < Math.floor(MAX_TOTAL_BYTES / frame.length); index++) decoder.feed(frame)
    expect(() => decoder.feed(frame)).toThrow()
  })
  const expected = { uid: '42', room: '6979222', text: 'fixture-message', cst: '1700000000000' }
  it('accepts cst or complete identity, room and exact text only', () => {
    expect(receiptMatch({ cst: expected.cst }, expected)).toBe('match')
    expect(receiptMatch({ uid: '42', rid: '6979222', txt: expected.text }, expected)).toBe('match')
    expect(receiptMatch({ res: '288' }, expected)).toBe('unassociated')
    expect(receiptMatch({ uid: '42', txt: expected.text }, expected)).toBe('unassociated')
  })
  it.each<GatewayMessage>([
    { cst: '1' }, { cst: expected.cst, uid: '99' }, { cst: expected.cst, rid: '1' },
    { cst: expected.cst, txt: 'another-message' }, { uid: '42', rid: '6979222', txt: expected.text, sender: '9' },
  ])('rejects conflicting receipt fields %#', message => { expect(receiptMatch(message, expected)).toBe('mismatch') })
})

describe('official fdm color permissions', () => {
  const list = (rows: Record<string, string | number>[]) => rows.map(row => `${escapeStt(serializeStt(row))}/`).join('')
  it('decodes both STT nesting levels and trusts explicit unlocks, not level numbers', () => {
    const payload = serializeStt({ type: 'fdm', list: list([{ col: 2, ul: 1, ubl: 6 }, { col: 1, ul: 0, ubl: 0 }, { col: 7, ul: 1, ubl: 66 }]) })
    expect([...messageColorPalette(parseMessagePayload(payload).list)]).toEqual([0, 2])
  })
  it('does not turn empty or unknown permission states into unlocked colors', () => {
    expect([...messageColorPalette('')]).toEqual([0])
    expect([...messageColorPalette(list([{ col: 3, ul: 2, ubl: 9 }]))]).toEqual([0])
  })
  it.each([
    list([{ col: 2, ul: 1 }, { col: 2, ul: 0 }]), list([{ col: 2 }]),
    list([{ col: -1, ul: 1 }]), list([{ col: 2, ul: 'invalid' }]),
    'col@=2/ul@=1/', 'col@A=2@Sul@A=1@S', 'col@A=2@Sul@A=1@Sul@A=0@S/',
    'x'.repeat(8_193), Array.from({ length: 33 }, (_, col) => `${escapeStt(serializeStt({ col, ul: 1 }))}/`).join(''),
  ])('rejects ambiguous, malformed or unbounded palette data %#', encoded => {
    expect(() => messageColorPalette(encoded)).toThrow('Unsupported')
  })
})
