import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../electron/contracts'
import { DanmakuRecords } from './records/DanmakuRecords'
import { BilibiliRoomInsights } from './insights/BilibiliRoomInsights'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('opens Bilibili records with SC and keeps a typed numeric room on Bilibili', async () => {
  const invoke = vi.fn(async (method: string) => method === 'queryDanmakuHistory' ? { ok: true, value: {
    items: [{ id: 'sc1', room: 'bilibili:6', platform: 'bilibili', text: '测试醒目留言', username: '观众', color: 0x12ab34, receivedAt: Date.now(), superChat: { price: 30 } }], total: 1, page: 1, pageSize: 50, hasMore: false,
  } } : { ok: false, message: method })
  vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } as unknown as StreamSyncerBridge)
  render(<DanmakuRecords initialTab="history" room="bilibili:6" onFill={() => {}} />)
  expect(await screen.findByText('测试醒目留言')).toBeTruthy()
  expect(screen.getByText('SC ¥30')).toBeTruthy()
  expect(screen.queryByText('收藏')).toBeNull()
  fireEvent.change(screen.getByLabelText('房间号'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('queryDanmakuHistory', expect.objectContaining({ room: 'bilibili:123456' })))
})

it('shows Bilibili metrics without replacing unavailable platform values with zero', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: { room: 'bilibili:6', messages: 12, users: 3, superChats: 2, superChatYuan: 60, rate: { receivedLastMinute: 9 }, capacity: 10000 } }))
  vi.stubGlobal('streamSyncer', { invoke, subscribeDanmaku: () => () => {} } as unknown as StreamSyncerBridge)
  render(<BilibiliRoomInsights room="bilibili:6" />)
  expect(await screen.findByText('12')).toBeTruthy()
  expect(screen.getAllByText('未收到')).toHaveLength(3)
  expect(invoke).toHaveBeenCalledWith('getBilibiliRoomInsights', { room: 'bilibili:6' })
})
