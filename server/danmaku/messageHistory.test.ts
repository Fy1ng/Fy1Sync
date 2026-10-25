import { describe, expect, it } from 'vitest'
import { MessageHistory, doseeingHistoryUrl } from './messageHistory'
import type { ChatMessage } from './douyuProtocol'

const chat = (id: string, changes: Partial<ChatMessage> = {}): ChatMessage => ({ id, room: '1', text: '原始弹幕 ' + id,
  username: 'viewer', color: 0, level: 30, receivedAt: 1_000, system: false, sender: { uid: '42', level: 30 }, ...changes })

describe('bounded raw reception history', () => {
  it('keeps raw events once across relay replays and bounds total memory', () => {
    const history = new MessageHistory({ capacity: 3, now: () => 1_000 })
    expect(history.observe(chat('a'))).toBe(true)
    expect(history.observe(chat('a'))).toBe(false)
    history.observe(chat('b', { room: '2' }))
    history.observe(chat('c'))
    history.observe(chat('d'))
    expect(history.search().items.map(item => item.id)).toEqual(['d', 'c', 'b'])
    expect(history.search()).toMatchObject({ coverage: 'received-only', total: 3, truncated: true })
    expect(history.search({ room: '1', uid: '42', query: '原始', pageSize: 1, page: 2 })).toMatchObject({ items: [chat('c')], total: 2, hasMore: false })
    expect(history.search({ query: 'missing' }).total).toBe(0)
  })

  it('does not expose mutable message references and clears only the selected room', () => {
    const history = new MessageHistory({ now: () => 1_000 })
    const input = chat('a', { sender: { uid: '42', fansBadge: { room: '1', name: '牌', level: 2 } } })
    history.observe(input)
    input.sender!.fansBadge!.name = 'changed'
    const page = history.search()
    page.items[0]!.sender!.fansBadge!.name = 'again'
    expect(history.search().items[0]!.sender!.fansBadge!.name).toBe('牌')
    history.observe(chat('b', { room: '2' }))
    history.clear('1')
    expect(history.search().items.map(item => item.room)).toEqual(['2'])
  })

  it('counts raw chat independently of gifts or replays and expires a minute of buckets', () => {
    let now = 1_000
    const history = new MessageHistory({ now: () => now })
    history.observe(chat('a'))
    history.observe(chat('a'))
    history.observe(chat('gift', { system: true, gift: { kind: 'gift', id: '824', count: 1 } }))
    now = 6_000
    history.observe(chat('b'))
    expect(history.rate('1')).toMatchObject({ receivedLastMinute: 2, messagesPerMinute: 24, sampleSeconds: 5 })
    now = 61_000
    expect(history.rate('1').receivedLastMinute).toBe(1)
    now = 66_000
    expect(history.rate('1').receivedLastMinute).toBe(0)
    now = 500
    expect(history.rate('1').since).toBeNull()
  })

  it('rejects unsafe query sizes and constructs only the fixed HTTPS history destination', () => {
    const history = new MessageHistory()
    for (const query of [{ page: -1 }, { pageSize: 999 }, { uid: '01' }, { room: '../1' }, { query: 'x'.repeat(201) }, { regex: '.*' }]) {
      expect(() => history.search(query)).toThrow()
    }
    expect(doseeingHistoryUrl('99999999999999999999')).toBe('https://www.doseeing.com/data/fan/99999999999999999999?type=chat&dt=0')
    for (const uid of ['42?next=evil', 'http://evil', '042', '0']) expect(() => doseeingHistoryUrl(uid)).toThrow()
    expect(history.observe(chat('a', { receivedAt: Infinity }))).toBe(false)
  })
})
