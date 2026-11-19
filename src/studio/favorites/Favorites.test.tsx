import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Favorites } from './Favorites'
import { resetSavedRooms, useSavedRooms } from '../savedRooms'
import type { FeatureEvent, SavedRoom } from '../../../electron/featureContracts'

const { loadInput, notice } = vi.hoisted(() => ({ loadInput: vi.fn(async () => true), notice: vi.fn() }))
vi.mock('../sources', async original => ({ ...(await original<object>()), useSourceLoader: () => ({ loadInput, state: { official: { busy: false }, commentary: { busy: false } } }) }))
vi.mock('../../app/SessionContext', () => ({ useSession: () => ({ notice }) }))
const NOW = Date.parse('2026-11-15T00:00:00Z')
const initial: SavedRoom = { id: 'one', role: 'official', input: '100', platform: 'douyu', label: '原始收藏', savedAt: NOW - 1000,
  metadata: { roomId: '100', url: 'https://www.douyu.com/100', nickname: '测试主播', title: '缓存标题', avatarUrl: null, coverUrl: null,
    status: 'live', lastStartedAt: NOW - 60_000, startTimeSource: 'platform', collectedAt: NOW } }
let rooms: SavedRoom[]
let listeners: Set<(event: FeatureEvent) => void>
const invoke = vi.fn(async (method: string, args: unknown) => {
  if (method === 'listSavedRooms' || method === 'refreshSavedRooms') return { ok: true, value: structuredClone(rooms) }
  if (method === 'saveRoom') {
    const room = { ...args as SavedRoom, id: 'two', savedAt: NOW }
    rooms.push(room)
    return { ok: true, value: room }
  }
  if (method === 'removeSavedRoom') {
    rooms = rooms.filter(room => room.id !== (args as { id: string }).id)
    return { ok: true, value: { removed: true } }
  }
  return { ok: false, message: '测试不支持此接口' }
})
beforeEach(() => {
  resetSavedRooms(); rooms = [structuredClone(initial)]; listeners = new Set(); invoke.mockClear(); loadInput.mockClear()
  vi.stubGlobal('streamSyncer', { invoke, subscribeFeatures: (listener: (event: FeatureEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) } })
})
afterEach(() => { cleanup(); resetSavedRooms(); vi.unstubAllGlobals() })
const publish = () => act(() => { for (const listener of listeners) listener({ topic: 'saved-rooms', data: { rooms: structuredClone(rooms) } }) })

describe('favorite rooms panel', () => {
  it.each(['failure', 'rejected', 'invalid'] as const)('keeps a %s list read separate from loading and empty, then retries', async (failure) => {
    if (failure === 'rejected') invoke.mockRejectedValueOnce(new Error('read failed'))
    else invoke.mockResolvedValueOnce((failure === 'failure'
      ? { ok: false, code: 'unavailable', message: '收藏读取失败' }
      : { ok: true, value: null }) as never)
    const view = render(<Favorites onClose={() => {}} />)
    expect(screen.getByText('正在读取收藏...')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(failure === 'rejected' ? '无法连接应用主进程' : '收藏读取失败')
    expect(screen.queryByText('正在读取收藏...')).toBeNull()
    expect(screen.queryByText(/还没有收藏/)).toBeNull()
    view.unmount()
    render(<Favorites onClose={() => {}} />)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('测试主播')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(invoke.mock.calls.filter(([method]) => method === 'listSavedRooms')).toHaveLength(2)
  })

  it('shows the empty state only after a successful empty list read', async () => {
    rooms = []
    render(<Favorites onClose={() => {}} />)
    expect(screen.queryByText(/还没有收藏/)).toBeNull()
    expect(await screen.findByText(/还没有收藏/)).toBeInTheDocument()
    expect(screen.queryByText('正在读取收藏...')).toBeNull()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('does not replace a pushed list with a failed older list read', async () => {
    let finish!: (value: { ok: false; code: string; message: string }) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<Favorites onClose={() => {}} />)
    publish()
    await act(async () => finish({ ok: false, code: 'unavailable', message: '旧读取失败' }))
    expect(screen.getByText('测试主播')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps receiving background updates while the panel is closed', async () => {
    const view = render(<Favorites onClose={() => {}} />)
    await screen.findByText('测试主播')
    expect(screen.getByLabelText('默认载入画面').textContent).toBe('画面')
    view.unmount()
    rooms[0]!.refreshError = '后台采集失败, 已保留缓存.'
    publish()
    render(<Favorites onClose={() => {}} />)
    await screen.findByText('后台采集失败, 已保留缓存.')
    expect(screen.getByText('缓存标题')).toBeTruthy()
  })

  it('shows cached data after failed collection and updates when a new successful snapshot arrives', async () => {
    render(<Favorites onClose={() => {}} />)
    await screen.findByText('测试主播')
    expect(screen.getByText('缓存标题')).toBeTruthy()
    rooms[0]!.refreshError = '采集失败, 已保留缓存.'
    publish()
    expect(screen.getByText('缓存标题')).toBeTruthy()
    expect(screen.getByText('上次采集缓存')).toBeTruthy()
    expect(screen.getByText('直播中')).toBeTruthy()
    rooms[0]!.metadata!.title = '最新标题'; rooms[0]!.metadata!.status = 'offline'; rooms[0]!.refreshError = null
    publish()
    expect(screen.getByText('最新标题')).toBeTruthy()
    expect(screen.getByText('未开播')).toBeTruthy()
    expect(screen.queryByText('缓存标题')).toBeNull()
  })

  it('filters by platform and searches streamer, title and room id', async () => {
    rooms.push({ ...initial, id: 'two', platform: 'bilibili', label: '哔哩收藏', metadata: { ...initial.metadata!, nickname: '另一主播', title: '赛事直播', roomId: '200' } })
    render(<Favorites onClose={() => {}} />)
    await screen.findByText('测试主播')
    fireEvent.change(screen.getByLabelText('搜索收藏直播间'), { target: { value: '赛事' } })
    expect(screen.queryByText('测试主播')).toBeNull()
    expect(screen.getByText('另一主播')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('筛选收藏平台'), { target: { value: 'douyu' } })
    expect(screen.getByText('没有匹配的收藏直播间.')).toBeTruthy()
  })

  it('saves an offline room without loading playback and can load either target explicitly', async () => {
    const onClose = vi.fn()
    render(<Favorites onClose={onClose} />)
    await screen.findByText('测试主播')
    fireEvent.change(screen.getByLabelText('收藏平台'), { target: { value: 'douyin' } })
    fireEvent.change(screen.getByLabelText('收藏直播间链接或房间号'), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: '收藏房间' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('saveRoom', { platform: 'douyin', input: '12345', role: 'official', label: '12345' }))
    expect(loadInput).not.toHaveBeenCalled()
    const first = within(screen.getByRole('list', { name: '收藏直播间列表' })).getAllByRole('listitem')[1]!
    fireEvent.click(within(first).getByRole('button', { name: '载入解说' }))
    await waitFor(() => expect(loadInput).toHaveBeenCalledWith('commentary', 'https://www.douyu.com/100', 'douyu'))
    expect(onClose).toHaveBeenCalled()
  })

  it('does not overwrite a pushed snapshot with an older initial list response', async () => {
    let finish!: (value: { ok: boolean; value: SavedRoom[] }) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    function Reader(): React.ReactNode { const current = useSavedRooms(); return <span>{current?.[0]?.metadata?.title ?? '读取中'}</span> }
    render(<Reader />)
    rooms[0]!.metadata!.title = '事件带来的新标题'
    publish()
    await act(async () => finish({ ok: true, value: [initial] }))
    expect(screen.getByText('事件带来的新标题')).toBeTruthy()
  })
})
