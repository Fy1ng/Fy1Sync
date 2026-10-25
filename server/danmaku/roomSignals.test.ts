import { describe, expect, it } from 'vitest'
import { escapeStt, parseStt, serializeStt, type DanmakuMessage } from './douyuProtocol'
import { parseDouyuRankList, parseDouyuRoomSignal } from './roomSignals'

const NOW = 1_793_000_000_000
const row = (fields: Record<string, string | number>) => serializeStt(fields)
const list = row({ uid: '42', nickname: 'A/B@C', gold: '12345' }) + '/' + row({ uid: '43', nickname: '同名', gold: '0' }) + '/'

describe('public room signals', () => {
  it('decodes nested ranking records at the correct STT layers', () => {
    const fields = parseStt(serializeStt({ type: 'ranklist', rid: '100', list_day: list, list: escapeStt(list), list_all: '' }))
    const event = parseDouyuRoomSignal(fields, '100', NOW)
    expect(event?.kind).toBe('ranks')
    if (event?.kind !== 'ranks') throw new Error('missing ranks')
    expect(event.ranks.day).toEqual([
      { uid: '42', nickname: 'A/B@C', gold: 12345, contribution: 123.45 },
      { uid: '43', nickname: '同名', gold: 0, contribution: 0 },
    ])
    expect(event.ranks.week).toEqual(event.ranks.day)
    expect(event.ranks.all).toEqual([])
    expect(event.ranks.currency).toBeNull()
  })
  it('does not invent gold or missing boards', () => {
    const event = parseDouyuRoomSignal({ type: 'ranklist', list: row({ nickname: 'x', gold: 'NaN' }) }, '100', NOW)
    if (event?.kind !== 'ranks') throw new Error('missing ranks')
    expect(event.ranks.day).toBeNull()
    expect(event.ranks.week?.[0]).toEqual({ uid: null, nickname: 'x', gold: null, contribution: null })
  })
  it.each(['nickname@=x/nickname@=y/gold@=1/', 'uid@=1/nickname@=x//uid@=1/nickname@=y//', 'no-record', 'x'.repeat(131_073)])
  ('refuses ambiguous or oversized rank data', raw => { expect(parseDouyuRankList(raw)).toBeNull() })
  it('bounds the number of rows and keeps equal nicknames distinct', () => {
    expect(parseDouyuRankList((row({ nickname: 'same', gold: '1' }) + '/').repeat(201))).toBeNull()
    expect(parseDouyuRankList(row({ nickname: 'same', uid: '1' }) + '/' + row({ nickname: 'same', uid: '2' }) + '/')).toHaveLength(2)
  })
  it('keeps replay and unknown replay flags distinct', () => {
    expect(parseDouyuRoomSignal({ type: 'rss', ss: '1', ivl: '1' }, '100', NOW)).toMatchObject({ live: true, replay: true })
    expect(parseDouyuRoomSignal({ type: 'rss', ss: '1' }, '100', NOW)).toMatchObject({ live: true, replay: null })
    expect(parseDouyuRoomSignal({ type: 'rss', ss: '2', ivl: '0' }, '100', NOW)).toMatchObject({ live: false, replay: false })
  })
  it('accepts an explicit zero noble count without interpreting it as viewers', () => {
    expect(parseDouyuRoomSignal({ type: 'oni', vn: '0' }, '100', NOW)).toEqual({ kind: 'nobles', room: '100', count: 0, receivedAt: NOW })
    expect(parseDouyuRoomSignal({ type: 'oni', vn: '-1' }, '100', NOW)).toBeNull()
  })
  const invalid: DanmakuMessage[] = [
    { type: 'rss', rid: '200', ss: '1', ivl: '0' }, { type: 'rss', ss: 'yes' },
    { type: 'rss', ss: '1', ivl: '2' }, { type: 'ranklist', list: 'invalid' }, { type: 'chatmsg', txt: 'x' },
  ]
  it.each(invalid)('rejects malformed, mismatched and unrelated traffic', fields => { expect(parseDouyuRoomSignal(fields, '100', NOW)).toBeNull() })
})
