/**
 * History search pages through local received danmaku; favorites can be filled into the send
 * box, which must never send anything; the third-party page opens only on an explicit click.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { DanmakuRecordsSheet } from './DanmakuRecords'

type Call = { method: string; args: unknown }
let calls: Call[] = []
let favorites: Array<{ id: string; text: string; room: string | null; uid: string | null; username: string | null; createdAt: number }> = []

const message = (n: number) => ({
  id: `m${n}`, text: `弹幕 ${n}`, username: `用户${n}`, color: 0, level: 1,
  receivedAt: Date.UTC(2026, 9, 26, 12, 0, n % 60), room: '9999', system: false, sender: { uid: '123' },
})

beforeEach(() => {
  calls = []
  favorites = [
    { id: 'f1', text: '好球', room: '9999', uid: '123', username: '甲', createdAt: 1 },
    { id: 'f2', text: '加油', room: null, uid: null, username: null, createdAt: 2 },
  ]
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      switch (method) {
        case 'queryDanmakuHistory': {
          const { page = 1, pageSize = 50 } = args as { page?: number; pageSize?: number }
          const total = 120
          const start = (page - 1) * pageSize
          const items = Array.from({ length: Math.max(0, Math.min(pageSize, total - start)) }, (_, i) => message(start + i))
          return { ok: true, value: { items, total, page, pageSize, hasMore: start + pageSize < total, coverage: 'received-only', capacity: 10000, truncated: false } }
        }
        case 'queryDanmakuFavorites':
          return { ok: true, value: { items: favorites.map((item) => ({ ...item })), total: favorites.length, page: 1, pageSize: 50, hasMore: false } }
        case 'updateDanmakuFavorite': {
          const { id, text } = args as { id: string; text: string }
          favorites = favorites.map((item) => item.id === id ? { ...item, text } : item)
          return { ok: true, value: favorites.find((item) => item.id === id) }
        }
        case 'removeDanmakuFavorite':
          favorites = favorites.filter((item) => item.id !== (args as { id: string }).id)
          return { ok: true, value: { removed: true } }
        case 'openDanmakuHistory': return { ok: true, value: { opened: true } }
        default: return { ok: false, code: 'unknown', message: method }
      }
    }) as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const historyCalls = () => calls.filter((call) => call.method === 'queryDanmakuHistory').map((call) => call.args)

describe('history', () => {
  it('searches the connected room by default and pages by 50', async () => {
    render(<DanmakuRecordsSheet initialTab="history" room="9999" onClose={() => {}} onFill={() => {}} />)
    const list = await screen.findByRole('list', { name: '历史弹幕' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(50)
    expect(historyCalls()[0]).toEqual({ room: '9999', query: '', page: 1, pageSize: 50 })
    expect(screen.getByText(/仅包含本应用运行期间接收到的弹幕/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ room: '9999', query: '', page: 2, pageSize: 50 }))
    fireEvent.click(await screen.findByRole('button', { name: '下一页' }))
    await waitFor(() => expect(historyCalls().at(-1)).toMatchObject({ page: 3 }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: '历史弹幕' })).getAllByRole('listitem')).toHaveLength(20))
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled()
  })

  it('applies the UID and text filters and returns to page 1', async () => {
    render(<DanmakuRecordsSheet initialTab="history" initialUid="123" room={null} onClose={() => {}} onFill={() => {}} />)
    await screen.findByRole('list', { name: '历史弹幕' })
    expect(historyCalls()[0]).toEqual({ uid: '123', query: '', page: 1, pageSize: 50 })
    fireEvent.change(screen.getByLabelText('弹幕内容'), { target: { value: '好' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ uid: '123', query: '好', page: 1, pageSize: 50 }))
  })

  it('opens Doseeing only when the button is clicked', async () => {
    render(<DanmakuRecordsSheet initialTab="history" room="9999" onClose={() => {}} onFill={() => {}} />)
    await screen.findByRole('list', { name: '历史弹幕' })
    expect(screen.queryByRole('button', { name: /在 Doseeing 查看/ })).toBeNull()
    fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: '123' } })
    const button = screen.getByRole('button', { name: /在 Doseeing 查看/ })
    expect(calls.map((call) => call.method)).not.toContain('openDanmakuHistory')
    fireEvent.click(button)
    await waitFor(() => expect(calls).toContainEqual({ method: 'openDanmakuHistory', args: { uid: '123' } }))
  })
})

describe('favorites', () => {
  it('fills the send box without sending', async () => {
    const onFill = vi.fn()
    render(<DanmakuRecordsSheet initialTab="favorites" room="9999" onClose={() => {}} onFill={onFill} />)
    const list = await screen.findByRole('list', { name: '收藏弹幕' })
    const row = within(list).getByText('好球').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: '填入发送框' }))
    expect(onFill).toHaveBeenCalledWith('好球')
    expect(calls.map((call) => call.method).filter((method) => /send|Douyu/i.test(method))).toEqual([])
  })

  it('edits a favorite inline', async () => {
    render(<DanmakuRecordsSheet initialTab="favorites" room={null} onClose={() => {}} onFill={() => {}} />)
    const list = await screen.findByRole('list', { name: '收藏弹幕' })
    const row = within(list).getByText('加油').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }))
    fireEvent.change(within(row).getByLabelText('编辑收藏内容'), { target: { value: '继续加油' } })
    fireEvent.click(within(row).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'updateDanmakuFavorite', args: { id: 'f2', text: '继续加油' } }))
    expect(await within(list).findByText('继续加油')).toBeInTheDocument()
  })

  it('deletes only after confirmation', async () => {
    render(<DanmakuRecordsSheet initialTab="favorites" room={null} onClose={() => {}} onFill={() => {}} />)
    const list = await screen.findByRole('list', { name: '收藏弹幕' })
    const row = within(list).getByText('好球').closest('li')!
    fireEvent.click(within(row).getByRole('button', { name: '删除' }))
    expect(calls.map((call) => call.method)).not.toContain('removeDanmakuFavorite')
    fireEvent.click(within(row).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(calls).toContainEqual({ method: 'removeDanmakuFavorite', args: { id: 'f1' } }))
    await waitFor(() => expect(screen.queryByText('好球')).toBeNull())
  })
})
