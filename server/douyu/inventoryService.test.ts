import { describe, expect, it, vi } from 'vitest'
import type { DouyuTaskManager } from '../../electron/douyuTasks'
import { DouyuInventoryService, inventorySnapshot, parseDouyuInventory } from './inventoryService'

const NOW = 1_800_000_000_000
const prop = (extra: Record<string, unknown> = {}) => ({ id: 777, name: '合成已有礼物', count: 3, propType: 1,
  isClick: 1, isValuable: 1, met: NOW / 1000 + 60, expiry: 1, price: 600, intimate: 60, batchInfo: {}, ...extra })

describe('complete inventory metadata without invented precision or currency', () => {
  it('separates the official day bucket from the second timestamp and preserves unknown currency', () => {
    const [item] = parseDouyuInventory({ list: [prop()] }, NOW)
    expect(item).toMatchObject({ propId: '777', quantity: 3, rawPrice: 600, unitValue: null, totalValue: null,
      intimacyPerUnit: 60, intimacyTotal: 180, canGift: true, batchSupported: false,
      expiration: { kind: 'timestamp', expiresAt: NOW + 60_000, dayBucket: 1 } })
    expect(JSON.stringify(item)).not.toContain('CNY')
  })

  it('retains known values per source currency and counts every unknown contribution', () => {
    const items = parseDouyuInventory({ list: [prop({ priceType: 'YUCHI' }), prop({ id: 778, priceType: 'YUWAN', price: 20 }),
      prop({ id: 779, price: undefined, intimate: undefined }), prop({ id: 780, price: 'bad', intimate: 'bad' })] }, NOW)
    const snapshot = inventorySnapshot('default', '100', NOW, items)
    expect(snapshot.totals).toEqual({ quantity: 12, knownValue: [
      { currency: 'YUCHI', amountMinor: 1800, scale: 100 }, { currency: 'YUWAN', amountMinor: 60, scale: 1 },
    ], unvaluedItems: 2, knownIntimacy: 360, unknownIntimacyItems: 2 })
    expect(items[2]).toMatchObject({ rawPrice: null, intimacyPerUnit: null, intimacyTotal: null })
  })

  it('keeps genuine zero intimacy distinct from missing intimacy', () => {
    const items = parseDouyuInventory({ list: [prop({ intimate: 0 }), prop({ id: 778, intimate: null })] }, NOW)
    expect(items.map(item => item.intimacyTotal)).toEqual([0, null])
  })

  it('does not turn expiry alone into a timestamp or permission to consume', () => {
    expect(parseDouyuInventory({ list: [prop({ met: undefined, expiry: 7 })] }, NOW)[0]).toMatchObject({ canGift: false,
      expiration: { kind: 'unknown', expiresAt: null, dayBucket: 7 } })
    expect(parseDouyuInventory({ list: [prop({ met: -1, expiry: 0 })] }, NOW)[0]).toMatchObject({ canGift: true,
      expiration: { kind: 'permanent', expiresAt: null, dayBucket: null } })
  })

  it.each([NOW / 1000, NOW / 1000 + 5, 'invalid', null, undefined])('refuses expired or unknown met=%s', met => {
    expect(parseDouyuInventory({ list: [prop({ met })] }, NOW)[0]?.canGift).toBe(false)
  })

  it.each([3, 4, 5, 6, 7, 8, 9, 10, 16, 18, 255, null])('reports nonordinary prop type=%s without using it', propType => {
    const item = parseDouyuInventory({ list: [prop({ propType })] }, NOW)[0]!
    expect(item.canGift).toBe(false)
    expect(item.unavailableReason).toBeTruthy()
    expect(item.quantity).toBe(3)
  })

  it.each([{ isClick: 0 }, { isClick: 2 }, { isClick: undefined }, { isValuable: undefined }, { extPropType: 'rightsProp' }, { count: 0 }])('blocks unknown, disabled or special use metadata %#', change => {
    expect(parseDouyuInventory({ list: [prop(change)] }, NOW)[0]?.canGift).toBe(false)
  })

  it('supports ordinary valuable inventory independently of the renewal whitelist', () => {
    const items = parseDouyuInventory({ list: [prop({ id: 99999, isValuable: 1, batchInfo: { '6': { batchNum: 6 } } })] }, NOW)
    expect(items[0]).toMatchObject({ propId: '99999', isValuable: true, batchSupported: true, canGift: true })
  })

  it.each([{}, { list: null }, { list: [prop(), prop()] }, { list: [prop({ count: -1 })] }, { list: [prop({ count: '1e3' })] },
    { list: [prop({ id: '0777' })] }, { error: 3, list: [] }, { list: [prop({ name: '' })] }])('never hides malformed required rows as an empty backpack %#', payload => {
    expect(() => parseDouyuInventory(payload, NOW)).toThrow()
  })

  it('does not invoke a getter or proxy while normalizing unknown input', () => {
    const getter = vi.fn(() => [prop()])
    expect(() => parseDouyuInventory(Object.defineProperty({}, 'list', { get: getter }), NOW)).toThrow()
    expect(() => parseDouyuInventory(new Proxy({ list: [] }, { get: getter }), NOW)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })

  it('returns no arbitrary upstream metadata or credentials', () => {
    const items = parseDouyuInventory({ list: [prop({ description: 'SYNTHETIC_PRIVATE', token: 'SYNTHETIC_PRIVATE', uid: '42' })] }, NOW)
    expect(JSON.stringify(inventorySnapshot('default', '100', NOW, items))).not.toMatch(/SYNTHETIC_PRIVATE|"uid"|"token"/)
  })
})

describe('account-bound inventory reads', () => {
  function harness() {
    const state = { activeAccountId: 'default', currentRoom: '100', ready: true }
    const tasks = { snapshot: (): ReturnType<DouyuTaskManager['snapshot']> => ({ activeAccountId: state.activeAccountId, currentRoom: state.currentRoom,
      retainedRooms: [], runtime: { foreground: true, locked: false, suspended: false }, tasks: [] }) }
    const readBackpack = vi.fn(async () => ({ uid: '42', payload: { list: [prop()] } }))
    const resolveRoom = vi.fn(async (room: string) => ({ ok: true as const, identity: { room, inputRoom: room } }))
    const service = new DouyuInventoryService({ tasks, gateway: { readBackpack }, accountReady: () => state.ready, resolveRoom, now: () => NOW })
    return { service, state, readBackpack, resolveRoom }
  }

  it('reads only after canonical room resolution and returns the public snapshot', async () => {
    const h = harness()
    const result = await h.service.read('default')
    expect(result).toMatchObject({ accountId: 'default', room: '100', checkedAt: NOW })
    expect(h.readBackpack.mock.calls[0]?.slice(0, 2)).toEqual(['default', '100'])
    expect(JSON.stringify(result)).not.toContain('"uid"')
    h.service.dispose()
  })

  it('rejects account changes during the read', async () => {
    const h = harness()
    h.readBackpack.mockImplementationOnce(async () => { h.state.ready = false; return { uid: '42', payload: { list: [prop()] } } })
    await expect(h.service.read('default', '100')).rejects.toMatchObject({ code: 'account-changed' })
    h.service.dispose()
  })

  it('cancels a superseded private read and sanitizes provider exceptions', async () => {
    const h = harness()
    h.readBackpack.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE'))
    await expect(h.service.read('default', '100')).rejects.toMatchObject({ code: 'invalid-data' })
    h.service.dispose()
    await expect(h.service.read('default', '100')).rejects.toMatchObject({ code: 'account-changed' })
  })
})
