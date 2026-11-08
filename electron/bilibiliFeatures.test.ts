import { expect, it } from 'vitest'
import { DanmakuFeatures } from './danmakuFeatures'
import { FeatureApi, createDanmakuHandlers } from '../server/featureApi'
import { copyBilibiliMetadata } from '../src/core/bilibiliMetadata'
import { DanmakuProcessor, DEFAULT_DANMAKU_PREFERENCES } from '../src/core/danmakuProcessing'
import type { ChatMessage } from '../server/danmaku/types'

it('retains searchable Bilibili messages and SC, isolates rooms and calculates room statistics', async () => {
  const features = new DanmakuFeatures({ load: () => undefined, save() {} })
  const message: ChatMessage = { id: 'bili-1', room: 'bilibili:6', platform: 'bilibili', text: '你好[笑]', username: '观众', bilibiliUid: '42', color: 0x12ab34, level: 0, system: false, receivedAt: Date.now(), emotes: [{ text: '[笑]', url: 'https://i0.hdslb.com/bfs/emote/a.png' }] }
  expect(features.observe(message)).toBe(true)
  expect(features.observe(message)).toBe(false)
  expect(features.observe({ ...message, id: 'sc-1', text: 'SC内容', superChat: { id: '1', price: 30, duration: 60, background: '#1565c0', color: '#ffffff' } })).toBe(true)
  features.observeBilibiliEvent({ type: 'signal', platform: 'bilibili', signal: { platform: 'bilibili', kind: 'watched', room: 'bilibili:6', receivedAt: Date.now(), count: 12345 } })
  expect(features.searchHistory({ room: '6' }).items).toEqual([])
  const page = features.searchHistory({ room: 'bilibili:6', uid: '42', query: '你好' })
  expect(page.total).toBe(1)
  expect(page.items[0]).toMatchObject({ color: 0x12ab34, platform: 'bilibili', emotes: message.emotes })
  page.items[0]!.emotes![0]!.text = 'mutated'
  expect(features.searchHistory({ room: 'bilibili:6', query: '你好' }).items[0]!.emotes![0]!.text).toBe('[笑]')
  const api = new FeatureApi(createDanmakuHandlers({ features, withAccount: async (_id, action) => action(new AbortController().signal), openExternal() {} }))
  expect(await api.invoke('getBilibiliRoomInsights', { room: 'bilibili:6' })).toMatchObject({ ok: true, value: { messages: 1, users: 1, superChats: 1, superChatYuan: 30, watched: 12345 } })
  expect(await api.invoke('getBilibiliRoomInsights', { room: '6' })).toMatchObject({ ok: false })
})

it('validates image URLs and SC metadata and keeps distinct SC out of duplicate merging', () => {
  expect(copyBilibiliMetadata({ emotes: [{ text: '[笑]', url: 'https://example.com/a.png' }, { text: '[好]', url: '//i0.hdslb.com/bfs/emote/a.png' }] }).emotes)
    .toEqual([{ text: '[好]', url: 'https://i0.hdslb.com/bfs/emote/a.png' }])
  const processor = new DanmakuProcessor({ ...DEFAULT_DANMAKU_PREFERENCES, duplicateMode: 'single', filterSuspectedBots: true })
  const message = { text: '相同的SC', platform: 'bilibili' as const, superChat: { id: '1' } }
  expect(processor.process(message, 1).kind).toBe('show')
  expect(processor.process(message, 2).kind).toBe('show')
})
