import { describe, expect, it, vi } from 'vitest'
import { DanmakuFeatures, type DanmakuFeaturesStorage } from './danmakuFeatures'
import type { ChatMessage } from '../server/danmaku/douyuProtocol'

function fixture(stored?: unknown) {
  let sequence = 0
  let disk = stored
  const save = vi.fn((value: DanmakuFeaturesStorage) => { disk = structuredClone(value) })
  const features = new DanmakuFeatures({ load: () => disk, save, id: () => 'favorite-' + ++sequence, now: () => 1_000 })
  return { features, save, read: () => disk }
}

describe('private danmaku preferences and explicit local favorites', () => {
  it('round-trips preferences and favorite CRUD without persisting raw history', () => {
    const { features, read } = fixture()
    expect(features.snapshot().preferences.showUserDetails).toBe(false)
    features.updatePreferences({ showUserDetails: true, verticalGapPx: 6 })
    features.updatePreferences({ duplicateMode: 'combo' })
    expect(features.snapshot().preferences).toMatchObject({ showUserDetails: true, verticalGapPx: 6, duplicateMode: 'combo' })
    features.updateAffixes({ enabled: true, suffix: '尾巴' })
    const added = features.addFavorite({ text: '收藏', room: '1', uid: '42', username: 'viewer' })
    features.updateFavorite(added.id, { text: '更新收藏' })
    expect(features.searchFavorites({ query: '更新', uid: '42' }).items[0]?.text).toBe('更新收藏')
    const restored = new DanmakuFeatures({ load: read, save: () => {} })
    expect(restored.searchFavorites().total).toBe(1)
    expect(restored.snapshot().affixes).toEqual({ enabled: true, prefix: '', suffix: '尾巴' })
    features.removeFavorite(added.id)
    expect(features.searchFavorites().total).toBe(0)
    expect(Object.keys(read() as object)).toEqual(['version', 'preferences', 'affixes', 'favorites'])
  })

  it('does not mutate saved state on failed storage or expose shared snapshots', () => {
    const { features, save } = fixture()
    const favorite = features.addFavorite({ text: 'keep' })
    favorite.text = 'outside mutation'
    expect(features.searchFavorites().items[0]?.text).toBe('keep')
    save.mockImplementation(() => { throw new Error('private-path') })
    expect(() => features.updatePreferences({ showUserDetails: true })).toThrow('原文件已保留')
    expect(features.snapshot().preferences.showUserDetails).toBe(false)
    expect(() => features.removeFavorite(favorite.id)).toThrow('原文件已保留')
    expect(features.searchFavorites().total).toBe(1)
  })

  it('deduplicates explicit favorites and bounds pagination and text', () => {
    const { features, save } = fixture()
    const a = features.addFavorite({ text: 'first', room: '1' })
    expect(features.addFavorite({ text: 'first', room: '1' }).id).toBe(a.id)
    expect(save).toHaveBeenCalledTimes(1)
    features.addFavorite({ text: 'second', room: '2' })
    expect(features.searchFavorites({ page: 2, pageSize: 1 })).toMatchObject({ items: [a], total: 2, hasMore: false })
    expect(() => features.addFavorite({ text: 'x'.repeat(2_001) })).toThrow()
    expect(() => features.addFavorite({ text: 'x', uid: 'https://evil' })).toThrow()
    expect(() => features.removeFavorite('missing')).toThrow('未找到')
  })

  it('fails closed on unsupported stored schemas and does not overwrite them', () => {
    const save = vi.fn()
    for (const bad of [{ version: 2 }, { version: 1, preferences: {}, affixes: {}, favorites: new Array(1) }]) {
      expect(() => new DanmakuFeatures({ load: () => bad, save })).toThrow('原文件已保留')
    }
    expect(save).not.toHaveBeenCalled()
  })

  it('exposes observed metadata only with the user-details switch enabled', () => {
    const { features, save } = fixture()
    const message: ChatMessage = { id: 'a', room: '1', text: '原始弹幕', username: 'viewer', color: 0, level: 30,
      receivedAt: 1_000, system: false, sender: { uid: '42', level: 30, fansBadge: { room: '1', name: '牌', level: 4 } } }
    features.observe(message)
    expect(features.userDetails('1', '42')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    features.updatePreferences({ showUserDetails: true })
    expect(features.userDetails('1', '42')).toMatchObject({ uid: '42', username: 'viewer', fansBadge: { level: 4 } })
    expect(features.searchHistory().coverage).toBe('received-only')
    expect(JSON.stringify(save.mock.calls[0])).not.toContain('原始弹幕')
  })
})
