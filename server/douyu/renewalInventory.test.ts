import { describe, expect, it, vi } from 'vitest'
import { parseRenewalInventory, parseRenewalTargets, RenewalInventoryError } from './renewalInventory'

const NOW = 1_800_000_000_000
const ERROR = '斗鱼续牌列表或背包数据无法确认, 请刷新后重试.'
const candidate = (values: Record<string, unknown> = {}) => ({
  id: 268, name: '荧光棒', count: 12, met: NOW / 1_000 + 60, propType: 1, isClick: 1, isValuable: 0, ...values,
})
const row = (room = '6979222', extra = '', cells = '<td>合成牌名</td><td>合成主播</td>') =>
  `<tr data-fans-room="${room}" ${extra}>${cells}</tr>`
const table = (rows: string, extra = '') =>
  `<table class="fans-badge-list" ${extra}><thead><tr><th>粉丝牌</th><th>主播</th></tr></thead><tbody>${rows}</tbody></table>`

describe('returned-page renewal target parsing', () => {
  it('reads the pinned reference table shape while leaving unknown badge names as room labels', () => {
    const html = table(row('6979222', 'data-fans-gbdgts="1700000000"') + row('100', 'data-fans-gbdgts="1500000000"'))
    expect(parseRenewalTargets(html)).toEqual([
      { room: '6979222', badgeName: '房间 6979222' }, { room: '100', badgeName: '房间 100' },
    ])
    expect(JSON.stringify(parseRenewalTargets(html))).not.toContain('1700000000')
  })

  it('recognizes a table inside the list container and ignores unrelated tables', () => {
    const html = `<table>${row('invalid', '', '<td>SYNTHETIC_SECRET</td>')}</table>`
      + `<div class="other fans-badge-list selected"><table><tbody>${row('100')}</tbody></table></div>`
    expect(parseRenewalTargets(html)).toEqual([{ room: '100', badgeName: '房间 100' }])
  })

  it('uses HTML entity and case rules rather than scanning apparent tags in attribute strings', () => {
    const html = `<div data-example="&lt;table class='fans-badge-list'&gt;${row('123').replaceAll('"', '&quot;')}&lt;/table&gt;"></div>`
      + '<TABLE CLASS="fans&#45;badge-list"><TBODY><TR DATA-FANS-ROOM="&#x31;00"><TD title="A &amp; B">合成 &lt;牌&gt; &#33639;</TD></TR></TBODY></TABLE>'
    expect(parseRenewalTargets(html)).toEqual([{ room: '100', badgeName: '房间 100' }])
  })

  it.each(['script', 'style', 'textarea', 'noscript', 'template', 'iframe'] as const)
  ('ignores fake target tables inside %s', tag => {
    const fake = `<${tag}>${table(row('200'))}</${tag}>`
    expect(parseRenewalTargets(fake + table(row('100')))).toEqual([{ room: '100', badgeName: '房间 100' }])
  })

  it('ignores valid foreign content but refuses tables moved out of malformed foreign markup', () => {
    const foreign = `<svg><foreignObject>${table(row('200'))}</foreignObject></svg>`
      + `<math><annotation-xml encoding="text/html">${table(row('300'))}</annotation-xml></math>`
    expect(parseRenewalTargets(foreign + table(row('100')))).toEqual([{ room: '100', badgeName: '房间 100' }])
    for (const tag of ['svg', 'math']) {
      expect(() => parseRenewalTargets(`<${tag}>${table(row('200'))}</${tag}>` + table(row('100')))).toThrow(ERROR)
    }
  })

  it('ignores comments and nested unrelated tables without treating their rows as targets', () => {
    const html = `<!-- ${table(row('200'))} -->`
      + table(row('100', '', `<td>合成牌<table>${row('300', '', '<td>嵌套内容</td>')}</table></td>`))
    expect(parseRenewalTargets(html)).toEqual([{ room: '100', badgeName: '房间 100' }])
  })

  it('deduplicates only matching parsed row metadata, including decoded entities', () => {
    const first = '<tr data-fans-room="100" data-fans-gbdgts="20"><td title="A &amp; B">合成&#38;牌</td></tr>'
    const second = '<tr data-fans-gbdgts="20" data-fans-room="&#49;00"><td title="A &#38; B">合成&amp;牌</td></tr>'
    expect(parseRenewalTargets(table(first + second))).toEqual([{ room: '100', badgeName: '房间 100' }])
  })

  it.each([
    row('100', 'data-fans-gbdgts="21"'),
    row('100', 'data-fans-gbdgts="20"', '<td>不同牌名</td><td>不同主播</td>'),
    row('100', 'data-fans-gbdgts="20" data-extra="ambiguous"'),
  ])('rejects duplicate rooms with inconsistent metadata: %#', duplicate => {
    expect(() => parseRenewalTargets(table(row('100', 'data-fans-gbdgts="20"') + duplicate))).toThrow(RenewalInventoryError)
  })

  it.each(['0', '0100', '-1', '1.0', '1e2', ' 100', '100 ', '1234567890123', 'https://www.douyu.com/100', '&#0;', '１００'])
  ('refuses a noncanonical room attribute: %#', room => {
    expect(() => parseRenewalTargets(table(row(room)))).toThrow(ERROR)
  })

  it.each([
    '', 'SYNTHETIC_SECRET', '<div class="fans-badge-list">加载中</div>',
    `<div class="fans-badge-list">${row('100')}</div>`,
    `<table class="fans-badge-list-other">${row('100')}</table>`,
    `<script>${table(row('100'))}</script>`,
    '<table class="fans-badge-list"><tbody></tbody></table>',
    '<div>暂无粉丝牌</div><table class="fans-badge-list"><tbody></tbody></table>',
    table('<tr><td>暂无数据</td></tr>'),
    table('<tr data-fans-gbdgts="1700000000"><td>缺房间号</td></tr>'),
    table('<tr data-fans-room="100"></tr>'),
    table('<tr data-fans-room="100" data-fans-room="200"><td>冲突</td></tr>'),
    '<table class="fans-badge-list"><tr data-fans-room="100"><td>未闭合',
    '<table class="fans-badge-list"><tr data-fans-room="100><td>属性未闭合</td></tr></table>',
    `<html><head><title>斗鱼用户登录</title></head><body>${table(row('100'))}</body></html>`,
    `<html><head><title>Login</title></head><body><form><input type="password"></form>${table(row('100'))}</body></html>`,
  ])('does not interpret malformed, unauthenticated or incomplete markup as no badges: %#', html => {
    expect(() => parseRenewalTargets(html)).toThrow(ERROR)
  })

  it('accepts only an explicit empty state inside the recognized table', () => {
    expect(parseRenewalTargets(table('<tr><td colspan="2">暂无<span>粉丝牌</span>.</td></tr>'))).toEqual([])
    expect(() => parseRenewalTargets(table('<tr><td colspan="2">暂无粉丝牌</td></tr>' + row('100')))).toThrow(ERROR)
    expect(() => parseRenewalTargets(table('<tr><td><script>"暂无粉丝牌"</script></td></tr>'))).toThrow(ERROR)
  })

  it('bounds source size and the number of source rows before deduplication', () => {
    expect(parseRenewalTargets(table(Array.from({ length: 128 }, (_, index) => row(String(index + 1))).join('')))).toHaveLength(128)
    expect(() => parseRenewalTargets(table(Array.from({ length: 129 }, () => row('100')).join('')))).toThrow(ERROR)
    expect(() => parseRenewalTargets('x'.repeat(1_048_577))).toThrow(ERROR)
  })

  it('does not expose source text or parser diagnostics through errors', () => {
    let error: unknown
    try { parseRenewalTargets('<table class="fans-badge-list">SYNTHETIC_SECRET') } catch (value) { error = value }
    expect(error).toBeInstanceOf(RenewalInventoryError)
    expect((error as Error).message).toBe(ERROR)
    expect((error as Error).stack).not.toContain('SYNTHETIC_SECRET')
  })
})

describe('existing ordinary glow-stick inventory parsing', () => {
  it.each([0, 1, 2])('admits only a fully identified current candidate with ordinary type %s', propType => {
    expect(parseRenewalInventory({ list: [candidate({ propType })] }, NOW)).toEqual([{
      id: '268', name: '荧光棒', count: 12, met: NOW / 1_000 + 60, propType, isClick: 1, isValuable: false, eligible: true, reason: null,
    }])
  })

  it('normalizes canonical numeric metadata and permits permanent stock without treating face value as a purchase', () => {
    const [item] = parseRenewalInventory({ list: [candidate({ id: '2358', name: '超级荧光棒', count: '12', met: '-1',
      propType: '2', isClick: '2', isValuable: false, price: 99_999, description: 'SYNTHETIC_SECRET', link: 'https://private.example/' })] }, NOW)
    expect(item).toEqual({ id: '2358', name: '超级荧光棒', count: 12, met: -1, propType: 2, isClick: 2, isValuable: false, eligible: true, reason: null })
    expect(JSON.stringify(item)).not.toContain('SYNTHETIC_SECRET')
    expect(item).not.toHaveProperty('price')
    expect(item).not.toHaveProperty('link')
  })

  it('removes controls and bidi formatting from names but does not interpret JSON names as HTML', () => {
    const [cleaned, encoded] = parseRenewalInventory({ list: [
      candidate({ name: '  荧\u0000光\u0085棒\u202e\uD800  ' }),
      candidate({ id: 2358, name: '&#33639;&#20809;&#26834;' }),
    ] }, NOW)
    expect(cleaned).toMatchObject({ name: '荧光棒', eligible: true })
    expect(encoded).toMatchObject({ name: '&#33639;&#20809;&#26834;', eligible: false })
  })

  it.each([3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 255])('excludes special, claim, exchange and unknown type %s', propType => {
    const [item] = parseRenewalInventory({ list: [candidate({ propType })] }, NOW)
    expect(item).toMatchObject({ propType, eligible: false, reason: expect.any(String) })
    if (propType === 5) expect(item!.reason).toContain('领取')
    if (propType >= 7 && propType <= 10) expect(item!.reason).toContain('兑换')
  })

  it.each([undefined, null, -1, 256, 1.5, NaN, Infinity, 'unknown', '01', true])('retains unknown type metadata as unusable: %#', propType => {
    expect(parseRenewalInventory({ list: [candidate({ propType })] }, NOW)[0]).toMatchObject({ propType: null, eligible: false })
  })

  it.each([undefined, null, -1, 0.5, NaN, Infinity, true, 'false'])('does not authorize an unknown click state: %#', isClick => {
    expect(parseRenewalInventory({ list: [candidate({ isClick })] }, NOW)[0]).toMatchObject({ isClick: null, eligible: false })
  })

  it.each([undefined, null, 'false', 'yes', 2, NaN])('does not infer value metadata from missing or unknown data: %#', isValuable => {
    expect(parseRenewalInventory({ list: [candidate({ isValuable })] }, NOW)[0]).toMatchObject({ isValuable: null, eligible: false })
  })

  it.each([true, 1, '1'])('excludes a valuable item even if it is already in the backpack: %#', isValuable => {
    expect(parseRenewalInventory({ list: [candidate({ isValuable })] }, NOW)[0]).toMatchObject({ isValuable: true, eligible: false })
  })

  it.each([false, 0, '0'])('requires an explicit false value flag: %#', isValuable => {
    expect(parseRenewalInventory({ list: [candidate({ isValuable })] }, NOW)[0]).toMatchObject({ isValuable: false, eligible: true })
  })

  it('keeps noncandidate, disabled and empty-stock rows visible with fixed reasons', () => {
    expect(parseRenewalInventory({ list: [candidate({ id: 999, name: '其他道具' })] }, NOW)[0]).toMatchObject({ eligible: false, reason: '非本次荧光棒候选' })
    expect(parseRenewalInventory({ list: [candidate({ name: '火箭' })] }, NOW)[0]).toMatchObject({ eligible: false })
    expect(parseRenewalInventory({ list: [candidate({ isClick: 0 })] }, NOW)[0]).toMatchObject({ eligible: false, reason: '当前不可使用' })
    expect(parseRenewalInventory({ list: [candidate({ count: 0 })] }, NOW)[0]).toMatchObject({ count: 0, eligible: false, reason: '库存不足' })
  })

  it('uses met seconds with a five-second safety window and never treats expiry as a timestamp', () => {
    expect(parseRenewalInventory({ list: [candidate({ met: undefined, expiry: NOW + 999_999 })] }, NOW)[0])
      .toMatchObject({ met: null, eligible: false, reason: '有效期未确认' })
    expect(parseRenewalInventory({ list: [candidate({ met: NOW / 1_000 + 5, expiry: 7 })] }, NOW)[0]).toMatchObject({ eligible: false })
    expect(parseRenewalInventory({ list: [candidate({ met: NOW / 1_000 + 6, expiry: 0 })] }, NOW)[0]).toMatchObject({ eligible: true })
    expect(parseRenewalInventory({ list: [candidate({ met: 0, expiry: 7 })] }, NOW)[0]).toMatchObject({ met: 0, eligible: false })
    expect(parseRenewalInventory({ list: [candidate({ met: NOW + 60_000 })] }, NOW)[0]).toMatchObject({ met: null, eligible: false })
    expect(parseRenewalInventory({ list: [candidate({ met: -1, expiry: 0 })] }, NOW)[0]).toMatchObject({ met: -1, eligible: true })
  })

  it.each([undefined, null, -2, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, '1e9', '01', {}])('keeps malformed expiry unavailable instead of inventing a deadline: %#', met => {
    expect(parseRenewalInventory({ list: [candidate({ met })] }, NOW)[0]).toMatchObject({ met: null, eligible: false })
  })

  it('does not interpret batchInfo as stock lots or alter the reported count', () => {
    const [item] = parseRenewalInventory({ list: [candidate({ count: 12, batchInfo: { 1: { batchNum: 1, name: '一根' }, 99: { batchNum: 99, name: '预设' } } })] }, NOW)
    expect(item).toMatchObject({ count: 12, eligible: true })
    expect(item).not.toHaveProperty('batchInfo')
  })

  it.each([
    { id: undefined }, { id: 0 }, { id: -1 }, { id: '0268' }, { id: '2.68e2' }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { name: undefined }, { name: null }, { name: '' }, { name: '\0\u202e' }, { name: 'x'.repeat(129) },
    { count: undefined }, { count: null }, { count: -1 }, { count: 0.5 }, { count: NaN },
    { count: Infinity }, { count: Number.MAX_SAFE_INTEGER + 1 }, { count: '01' },
  ])('rejects malformed identity, name or quantity instead of returning empty stock: %#', values => {
    expect(() => parseRenewalInventory({ list: [candidate(values)] }, NOW)).toThrow(ERROR)
  })

  it.each([null, [], {}, { data: { list: [] } }, { list: null }, { list: {} }, { list: '[]' }, { list: [null] }, { list: [[]] },
    { error: 9, list: [] }, { error: null, list: [] }, { success: false, list: [] }, { success: 'unknown', list: [] }])
  ('requires a real inner payload and list: %#', payload => {
    expect(() => parseRenewalInventory(payload, NOW)).toThrow(ERROR)
  })

  it('accepts an explicit empty list, null-prototype data and frozen input without mutating it', () => {
    expect(parseRenewalInventory({ list: [] }, NOW)).toEqual([])
    const item = Object.freeze(Object.assign(Object.create(null), candidate()))
    const payload = Object.freeze(Object.assign(Object.create(null), { list: Object.freeze([item]) }))
    const [result] = parseRenewalInventory(payload, NOW)
    result!.count = 1
    expect(item.count).toBe(12)
    expect(result).not.toBe(item)
  })

  it('rejects duplicate prop IDs rather than summing or choosing an expiry batch', () => {
    expect(() => parseRenewalInventory({ list: [candidate(), candidate()] }, NOW)).toThrow(ERROR)
    expect(() => parseRenewalInventory({ list: [candidate(), candidate({ id: '268', count: 3, met: -1 })] }, NOW)).toThrow(ERROR)
  })

  it('bounds list size and rejects holes, extra array fields and unusual prototypes', () => {
    const items = Array.from({ length: 256 }, (_, index) => candidate({ id: index + 1 }))
    expect(parseRenewalInventory({ list: items }, NOW)).toHaveLength(256)
    expect(() => parseRenewalInventory({ list: [...items, candidate({ id: 999 })] }, NOW)).toThrow(ERROR)
    expect(() => parseRenewalInventory({ list: new Array(1) }, NOW)).toThrow(ERROR)
    expect(() => parseRenewalInventory({ list: Object.assign([candidate()], { extra: true }) }, NOW)).toThrow(ERROR)
    expect(() => parseRenewalInventory({ list: [Object.assign(Object.create({ inherited: true }), candidate())] }, NOW)).toThrow(ERROR)
    class List extends Array<unknown> {}
    expect(() => parseRenewalInventory({ list: new List(candidate()) }, NOW)).toThrow(ERROR)
  })

  it('never evaluates field getters, array getters or proxy reflection', () => {
    const getter = vi.fn(() => 'SYNTHETIC_SECRET')
    const proxyTrap = vi.fn(() => Object.prototype)
    for (const payload of [
      Object.defineProperty({}, 'list', { get: getter }),
      { list: [Object.defineProperty(candidate(), 'name', { get: getter })] },
      { list: [Object.defineProperty(candidate(), 'met', { get: getter })] },
      { list: [Object.defineProperty(candidate(), 'privateDetail', { get: getter })] },
      { list: Object.defineProperty([candidate()], '0', { get: getter }) },
      { list: [new Proxy(candidate(), { getPrototypeOf: proxyTrap })] },
    ]) expect(() => parseRenewalInventory(payload, NOW)).toThrow(ERROR)
    expect(getter).not.toHaveBeenCalled()
    expect(proxyTrap).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])('requires a safe current timestamp: %#', now => {
    expect(() => parseRenewalInventory({ list: [candidate()] }, now)).toThrow(ERROR)
  })
})
