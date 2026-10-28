import { describe, expect, it, vi } from 'vitest'
import { DouyuReadCache } from './readCache'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('short-lived Douyu read cache', () => {
  it.each([
    ['followed', 60_000], ['inventory', 60_000], ['watch', 120_000],
  ] as const)('expires %s at its specified TTL boundary', async (kind, ttl) => {
    let now = 10_000
    const cache = new DouyuReadCache(() => now)
    const load = vi.fn(async (): Promise<{ revision: number }> => ({ revision: load.mock.calls.length }))
    expect(await cache.read(kind, 'account-a', '100', false, load)).toEqual({ revision: 1 })
    now += ttl - 1
    expect(await cache.read(kind, 'account-a', '100', false, load)).toEqual({ revision: 1 })
    expect(load).toHaveBeenCalledTimes(1)
    now++
    expect(await cache.read(kind, 'account-a', '100', false, load)).toEqual({ revision: 2 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('isolates read kinds, accounts and rooms', async () => {
    const cache = new DouyuReadCache()
    const load = vi.fn(async (): Promise<{ revision: number }> => ({ revision: load.mock.calls.length }))
    const scopes = [
      ['inventory', 'a', '100'], ['inventory', 'b', '100'], ['inventory', 'a', '200'],
      ['watch', 'a', '100'], ['followed', 'a', ''],
    ] as const
    for (const [index, [kind, account, room]] of scopes.entries()) {
      expect(await cache.read(kind, account, room, undefined, load)).toEqual({ revision: index + 1 })
    }
    for (const [index, [kind, account, room]] of scopes.entries()) {
      expect(await cache.read(kind, account, room, undefined, load)).toEqual({ revision: index + 1 })
    }
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('refreshes an unexpired entry and makes the refreshed result reusable', async () => {
    const cache = new DouyuReadCache()
    const load = vi.fn(async (): Promise<{ revision: number }> => ({ revision: load.mock.calls.length }))
    await cache.read('followed', 'a', '', false, load)
    expect(await cache.read('followed', 'a', '', true, load)).toEqual({ revision: 2 })
    expect(await cache.read('followed', 'a', '', false, load)).toEqual({ revision: 2 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not cache failed loads or return an older value after a failed refresh', async () => {
    const cache = new DouyuReadCache()
    const load = vi.fn<() => Promise<{ revision: number }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ revision: 1 })
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce({ revision: 2 })
    await expect(cache.read('inventory', 'a', '100', false, load)).rejects.toThrow('offline')
    expect(await cache.read('inventory', 'a', '100', false, load)).toEqual({ revision: 1 })
    await expect(cache.read('inventory', 'a', '100', true, load)).rejects.toThrow('refresh failed')
    expect(await cache.read('inventory', 'a', '100', false, load)).toEqual({ revision: 2 })
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('detaches both loader-owned and caller-owned nested DTOs', async () => {
    const cache = new DouyuReadCache(), dto = { items: [{ quantity: 10 }] }
    const load = vi.fn(async () => dto)
    const first = await cache.read('inventory', 'a', '100', false, load)
    dto.items[0]!.quantity = 20
    first.items[0]!.quantity = 30
    const second = await cache.read('inventory', 'a', '100', false, load)
    expect(second).toEqual({ items: [{ quantity: 10 }] })
    second.items.length = 0
    expect(await cache.read('inventory', 'a', '100', false, load)).toEqual({ items: [{ quantity: 10 }] })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('invalidates only the selected account or clears all accounts explicitly', async () => {
    const cache = new DouyuReadCache()
    const load = vi.fn(async (): Promise<{ revision: number }> => ({ revision: load.mock.calls.length }))
    await cache.read('followed', 'a', '', false, load)
    await cache.read('followed', 'b', '', false, load)
    cache.invalidate('a')
    expect(await cache.read('followed', 'a', '', false, load)).toEqual({ revision: 3 })
    expect(await cache.read('followed', 'b', '', false, load)).toEqual({ revision: 2 })
    cache.invalidate()
    expect(await cache.read('followed', 'a', '', false, load)).toEqual({ revision: 4 })
    expect(await cache.read('followed', 'b', '', false, load)).toEqual({ revision: 5 })
  })

  it('does not repopulate a cache invalidated while its provider is still running', async () => {
    const cache = new DouyuReadCache(), pending = deferred<{ revision: number }>()
    const first = cache.read('watch', 'a', '100', false, () => pending.promise)
    cache.invalidate('a')
    pending.resolve({ revision: 1 })
    expect(await first).toEqual({ revision: 1 })
    const load = vi.fn(async () => ({ revision: 2 }))
    expect(await cache.read('watch', 'a', '100', false, load)).toEqual({ revision: 2 })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not let an older request overwrite a successful explicit refresh', async () => {
    const cache = new DouyuReadCache(), old = deferred<{ revision: number }>()
    const first = cache.read('watch', 'a', '100', false, () => old.promise)
    expect(await cache.read('watch', 'a', '100', true, async () => ({ revision: 2 }))).toEqual({ revision: 2 })
    old.resolve({ revision: 1 })
    await first
    const load = vi.fn(async () => ({ revision: 3 }))
    expect(await cache.read('watch', 'a', '100', false, load)).toEqual({ revision: 2 })
    expect(load).not.toHaveBeenCalled()
  })

  it('does not let an older rejected request evict a refreshed value', async () => {
    const cache = new DouyuReadCache(), old = deferred<{ revision: number }>()
    const first = cache.read('inventory', 'a', '100', false, () => old.promise)
    const rejected = expect(first).rejects.toThrow('late failure')
    await cache.read('inventory', 'a', '100', true, async () => ({ revision: 2 }))
    old.reject(new Error('late failure'))
    await rejected
    const load = vi.fn(async () => ({ revision: 3 }))
    expect(await cache.read('inventory', 'a', '100', false, load)).toEqual({ revision: 2 })
    expect(load).not.toHaveBeenCalled()
  })
})
