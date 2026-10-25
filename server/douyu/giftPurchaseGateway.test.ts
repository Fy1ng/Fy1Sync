import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../config'
import type { DouyuActionDependencies } from './actions'
import { DouyuGiftPurchaseGateway, parseDouyuGiftBalance, parseDouyuGiftCatalog } from './giftPurchaseGateway'
import type { DouyuGiftBalanceProvider, DouyuGiftPurchase } from './inventoryTypes'

const NOW = 1_800_000_000_000
const COOKIE = 'acf_uid=42; acf_auth=SYNTHETIC_PRIVATE_AUTH'
const CATALOG = 'https://gift.douyucdn.cn/api/gift/v5/web/list?rid=100'
const PURCHASE = 'https://www.douyu.com/japi/gift/donate/mainsite/v3'
const signal = () => new AbortController().signal
const gift = (extra: Record<string, unknown> = {}) => ({ id: 20002, name: '合成办卡', donateStatus: 1, basicInfo: { giftType: 0, guardLevel: 0 },
  priceInfo: { priceType: 'YUCHI', price: 600 }, defaultSkinId: 9, fansLevel: 0, countLimit: 0, isBatchLimited: 0, startTime: 0, endTime: 0, ...extra })
const catalog = (items = [gift()]) => ({ error: 0, data: { onceLimit: 500000, giftList: items } })
const input: DouyuGiftPurchase = { accountId: 'default', expectedUid: '42', room: '100', giftId: '20002', quantity: 2, skinId: 9,
  unitPrice: { currency: 'YUCHI', amountMinor: 600, scale: 100 }, expectedBalance: 100_000 }

function setup(overrides: Partial<DouyuActionDependencies> & { balances?: DouyuGiftBalanceProvider } = {}) {
  const cookieHeader = vi.fn<DouyuActionDependencies['cookieHeader']>(async () => COOKIE)
  const balances = vi.fn<DouyuGiftBalanceProvider>(async () => ({ uid: '42', checkedAt: NOW, balances: { YUCHI: 100_000, YUWAN: 1_000_000 } }))
  const request = vi.fn<typeof fetch>(async url => {
    if (String(url) === CATALOG) return Response.json(catalog())
    if (String(url) === PURCHASE) return Response.json({ error: 0, data: { sb: 98_800, ry: 0, noble_gold: 0 } })
    throw new Error('Fixture rejects other URLs')
  })
  const resolve = vi.fn(async () => ['8.8.8.8'])
  const gateway = new DouyuGiftPurchaseGateway({ proxy: resolveConfig({}).proxy, cookieHeader, resolve, request, ...overrides }, overrides.balances ?? balances, () => NOW)
  return { gateway, request, cookieHeader, balances, resolve }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('catalog and trusted member balance normalization', () => {
  it('parses the current official giftList shape without treating priceType as price', () => {
    const result = parseDouyuGiftCatalog(catalog(), '100', NOW)
    expect(result).toMatchObject({ onceLimit: 500000, items: [{ giftId: '20002', name: '合成办卡', available: true,
      unitPrice: { currency: 'YUCHI', amountMinor: 600, scale: 100 } }] })
    expect(parseDouyuGiftCatalog(catalog([gift({ priceInfo: { priceType: 600 } })]), '100', NOW).items[0]).toMatchObject({ available: false, unitPrice: null })
  })

  it('keeps YUWAN separate, including zero balance, and never fabricates missing balances', () => {
    expect(parseDouyuGiftBalance('42', { gold: '12345', silver: '0' }, NOW)).toEqual({ uid: '42', checkedAt: NOW, balances: { YUCHI: 12345, YUWAN: 0 } })
    expect(parseDouyuGiftBalance('42', { gold: 'bad' }, NOW).balances).toEqual({ YUCHI: null, YUWAN: null })
    expect(parseDouyuGiftCatalog(catalog([gift({ priceInfo: { priceType: 'YUWAN', price: 100 } })]), '100', NOW).items[0]?.unitPrice)
      .toEqual({ currency: 'YUWAN', amountMinor: 100, scale: 1 })
  })

  it.each([{ donateStatus: 0 }, { basicInfo: { giftType: 20, guardLevel: 0 } }, { basicInfo: { giftType: 0, guardLevel: 1 } },
    { fansLevel: 2 }, { priceInfo: { priceType: 'UNKNOWN', price: 600 } }, { priceInfo: { priceType: 'YUCHI', price: 0 } },
    { isBatchLimited: 1 }, { startTime: NOW / 1000 + 60 }, { endTime: NOW / 1000 }])('exposes a reason for unsupported gift metadata %#', change => {
    const result = parseDouyuGiftCatalog(catalog([gift(change)]), '100', NOW).items[0]!
    expect(result.available).toBe(false)
    expect(result.unavailableReason).toBeTruthy()
  })

  it.each([{}, { error: 0, data: {} }, { error: 1, data: { giftList: [] } }, { error: 0, result: 7, data: { giftList: [] } },
    catalog([gift(), gift()]), catalog([gift({ id: '020002' })])])('refuses ambiguous catalog payloads %#', payload => {
    expect(() => parseDouyuGiftCatalog(payload, '100', NOW)).toThrow()
  })
})

describe('bounded official routes and credential isolation', () => {
  it('fetches the anonymous catalog without cookies and leaves raw asset metadata private', async () => {
    const h = setup()
    expect((await h.gateway.readCatalog('100', signal())).items).toHaveLength(1)
    expect(h.cookieHeader).not.toHaveBeenCalled()
    expect(h.request).toHaveBeenCalledOnce()
    expect(new Headers(h.request.mock.calls[0]?.[1]?.headers).has('cookie')).toBe(false)
    expect(h.request.mock.calls[0]?.[1]?.redirect).toBe('manual')
  })

  it.each(['127.0.0.1', '10.0.0.1', '::1'])('refuses private DNS address %s', address => {
    const h = setup({ resolve: async () => [address] })
    return expect(h.gateway.readCatalog('100', signal())).rejects.toThrow().then(() => { expect(h.request).not.toHaveBeenCalled() })
  })

  it('refuses redirects and duplicate status keys without forwarding account credentials', async () => {
    const h = setup({ request: async () => new Response('{"error":5,"error":0,"data":{"giftList":[]}}') })
    await expect(h.gateway.readCatalog('100', signal())).rejects.toThrow()
    const redirect = setup({ request: async () => new Response(null, { status: 302, headers: { location: 'https://example.test/' } }) })
    await expect(redirect.gateway.readCatalog('100', signal())).rejects.toThrow()
  })

  it.each([
    { uid: '99', checkedAt: NOW, balances: { YUCHI: 100000, YUWAN: 0 } },
    { uid: '42', checkedAt: NOW - 1, balances: { YUCHI: 100000, YUWAN: 0 } },
    { uid: '42', checkedAt: NOW + 1001, balances: { YUCHI: 100000, YUWAN: 0 } },
  ])('refuses wrong-account or stale balance proofs %#', balance => {
    const h = setup({ balances: async () => balance })
    return expect(h.gateway.readBalance('default', '100', signal())).rejects.toThrow()
  })

  it('rechecks authentication after the balance provider and sanitizes private failures', async () => {
    let calls = 0
    const h = setup({ cookieHeader: async () => ++calls > 1 ? COOKIE.replace('SYNTHETIC_PRIVATE_AUTH', 'changed') : COOKIE })
    await expect(h.gateway.readBalance('default', '100', signal())).rejects.toMatchObject({ code: 'login-required' })
    const failing = setup({ balances: async () => { throw new Error(COOKIE) } })
    const error = await failing.gateway.readBalance('default', '100', signal()).catch(error => error as Error)
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE')
  })
})

describe('explicit purchase without fallback or retry', () => {
  it('submits exactly the verified v3 form after fresh account, price and balance checks', async () => {
    const h = setup()
    expect(await h.gateway.purchase(input, signal())).toMatchObject({ status: 'receipt-received' })
    expect(h.request).toHaveBeenCalledTimes(2)
    const [url, init] = h.request.mock.calls[1]!
    expect(String(url)).toBe(PURCHASE)
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ giftId: '20002', giftCount: '2', roomId: '100', bizExt: '{"yzxq":{}}', skinId: '9' })
    expect(new Headers(init?.headers).get('cookie')).toBe(COOKIE)
    expect(new Headers(h.request.mock.calls[0]?.[1]?.headers).get('cookie')).toBeNull()
    expect(h.cookieHeader.mock.calls.every(call => call[0] === 'default' && call[1] === PURCHASE)).toBe(true)
    expect(JSON.stringify(h.request.mock.calls.map(([url]) => String(url)))).not.toMatch(/recharge|pay|prop\/donate/)
  })

  it.each([{ expectedBalance: 1 }, { unitPrice: { currency: 'YUCHI', amountMinor: 601, scale: 100 } }, { skinId: 5 }, { expectedUid: '99' },
    { quantity: 0 }, { quantity: Number.MAX_SAFE_INTEGER }, { giftId: '20002&url=evil' }])('rejects unsafe or changed purchase parameters %#', change => {
    const h = setup()
    return h.gateway.purchase({ ...input, ...change } as DouyuGiftPurchase, signal()).then(result => {
      expect(result.status).toBe('not-submitted')
      expect(h.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    })
  })

  it.each([null, 99_999, 100_001])('does not purchase when the latest balance is %s', value => {
    const h = setup({ balances: async () => ({ uid: '42', checkedAt: NOW, balances: { YUCHI: value, YUWAN: 0 } }) })
    return h.gateway.purchase(input, signal()).then(result => {
      expect(result.status).toBe('not-submitted')
      expect(h.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
    })
  })

  it.each([{ error: 10 }, { error: 11 }, { error: 16 }, { result: 170001 }, { error: 0, data: {} }, { error: 0, data: { sb: 0, giftId: 999 } },
    { error: 0, code: 9, data: { sb: 0 } }])('stops after an uncertain or rejected response %#', receipt => {
    let posts = 0
    const h = setup({ request: async (url, init) => {
      if (String(url) === CATALOG) return Response.json(catalog())
      if (String(url) === PURCHASE && init?.method === 'POST') { posts++; return Response.json(receipt) }
      throw new Error('Unexpected fixture request')
    } })
    return h.gateway.purchase(input, signal()).then(result => { expect(result.status).toBe('unknown'); expect(posts).toBe(1) })
  })

  it('retains the submitted transport until settlement even when it ignores cancellation', async () => {
    let release!: (response: Response) => void
    let posts = 0
    const pending = new Promise<Response>(resolve => { release = resolve })
    const h = setup({ request: async url => {
      if (String(url) === CATALOG) return Response.json(catalog())
      if (String(url) === PURCHASE) { posts++; return pending }
      throw new Error('Unexpected URL')
    } })
    const controller = new AbortController()
    let settled = false
    const operation = h.gateway.purchase(input, controller.signal).then(value => { settled = true; return value })
    for (let i = 0; i < 100; i++) await Promise.resolve()
    expect(posts).toBe(1)
    controller.abort()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(settled).toBe(false)
    release(Response.json({ error: 0, data: { sb: 98800 } }))
    expect((await operation).status).toBe('unknown')
    expect(posts).toBe(1)
  })
})
