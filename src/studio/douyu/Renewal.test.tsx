/**
 * Renewal gives away real items, so the rules that keep it honest are pinned here: only a
 * reviewed plan is executed, by id; any edit retires the plan; leaving retires it too.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import { Renewal } from './Renewal'

type Call = { method: string; args: unknown }
let calls: Call[] = []

const page = {
  accountId: 'a1', checkedAt: 1, coverage: 'all-pages', pageCount: 1, message: '',
  targets: [{ room: '100', badgeName: '甲' }, { room: '200', badgeName: '乙' }],
}
const planFor = (rooms: string[], id: string) => ({
  id, accountId: 'a1', createdAt: Date.now(), expiresAt: Date.now() + 60_000, message: '',
  totalQuantity: rooms.length,
  rows: rooms.map((room) => ({ room, badgeName: room, status: 'ready', reason: null,
    gift: { propId: '268', name: '荧光棒', quantity: 1, stock: 10, expiresAt: null } })),
})

beforeEach(() => {
  calls = []
  let plans = 0
  vi.stubGlobal('streamSyncer', {
    invoke: vi.fn(async (method: string, args: unknown) => {
      calls.push({ method, args })
      if (method === 'getDouyuRenewalTargets') return { ok: true, value: page }
      if (method === 'previewDouyuRenewal') return { ok: true, value: planFor((args as { rooms: string[] }).rooms, `p${++plans}`) }
      if (method === 'previewDouyuRenewalEqual') {
        const rooms = (args as { rooms: string[] }).rooms
        return { ok: true, value: { ...planFor(rooms, `p${++plans}`), totalQuantity: 3,
          rows: rooms.map((room, index) => index === 0
            ? { room, badgeName: room, status: 'ready', reason: null, gift: { propId: '268', name: '荧光棒', quantity: 3, stock: 7, expiresAt: null } }
            : { room, badgeName: room, status: 'skipped', reason: '没有可核对的普通背包荧光棒，本次跳过', gift: null }),
          allocation: { mode: 'equal-per-prop', leftovers: [{ propId: '268', quantity: 1 }] } } }
      }
      if (method === 'getDouyuBadgeAges') {
        return { ok: true, value: { accountId: 'a1', checkedAt: 1, coverage: 'returned-page', badges: [
          { room: '100', badgeName: '甲', acquiredAt: Date.UTC(2024, 0, 15), heldDays: 30 },
          { room: '200', badgeName: '乙', acquiredAt: null, heldDays: null },
        ] } }
      }
      if (method === 'executeDouyuRenewal') {
        const planId = (args as { planId: string }).planId
        return { ok: true, value: { planId, status: 'completed', message: '赠送已处理，请到斗鱼核对粉丝牌是否续期', rows: [] } }
      }
      if (method === 'cancelDouyuRenewal') return { ok: true, value: { cancelled: true } }
      return { ok: false, message: 'unexpected' }
    }) as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const named = (method: string): Call[] => calls.filter((call) => call.method === method)

async function toPlan(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /粉丝牌/ }))
  await screen.findByRole('checkbox', { name: /房间 100/ })
  fireEvent.click(screen.getByRole('checkbox', { name: /房间 100/ }))
  fireEvent.click(screen.getByRole('button', { name: '生成核对单' }))
  await screen.findByRole('region', { name: '赠送核对单' })
}

describe('badge renewal', () => {
  it('executes the reviewed plan by id and nothing else', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    fireEvent.click(screen.getByRole('button', { name: '确认赠送' }))
    const result = await screen.findByRole('region', { name: '赠送处理结果' })
    expect(within(result).getByText('处理完成')).toBeInTheDocument()
    expect(within(result).getByText('已送出，是否续上请到斗鱼确认')).toBeInTheDocument()
    expect(within(result).queryByText('赠送已处理，请到斗鱼核对粉丝牌是否续期')).toBeNull()
    expect(named('executeDouyuRenewal')).toEqual([{ method: 'executeDouyuRenewal', args: { planId: 'p1' } }])
  })

  it('retires the plan when the selection changes, and cannot confirm the stale one', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 200/ }))
    await waitFor(() => expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }]))
    expect(screen.queryByRole('region', { name: '赠送核对单' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
  })

  it.each(['room', 'quantity', 'allocation', 'override'])('rejects an in-flight preview after editing %s and allows a fresh preview', async (edit) => {
    const bridge = window.streamSyncer!
    const invoke = bridge.invoke
    let finish: ((value: unknown) => void) | undefined
    let pending = true
    bridge.invoke = vi.fn((method: string, args: unknown) => {
      if (method === 'previewDouyuRenewal' && pending) {
        pending = false
        return new Promise(resolve => { finish = resolve })
      }
      return invoke(method as never, args as never)
    }) as StreamSyncerBridge['invoke']
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    fireEvent.click(screen.getByRole('button', { name: /粉丝牌/ }))
    await screen.findByRole('checkbox', { name: /房间 100/ })
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 100/ }))
    if (edit === 'override') fireEvent.click(screen.getByRole('radio', { name: '逐房数量' }))
    fireEvent.click(screen.getByRole('button', { name: '生成核对单' }))
    await waitFor(() => expect(finish).toBeDefined())
    if (edit === 'room') fireEvent.click(screen.getByRole('checkbox', { name: /房间 200/ }))
    if (edit === 'quantity') fireEvent.change(screen.getByRole('spinbutton', { name: '每个房间赠送数量' }), { target: { value: '2' } })
    if (edit === 'allocation') fireEvent.click(screen.getByRole('radio', { name: '逐房数量' }))
    if (edit === 'override') fireEvent.change(screen.getByRole('spinbutton', { name: '房间 100 的赠送数量' }), { target: { value: '3' } })
    await act(async () => { finish!({ ok: true, value: planFor(['100'], 'obsolete') }) })
    expect(screen.queryByRole('region', { name: '赠送核对单' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
    expect(named('cancelDouyuRenewal')).toContainEqual({ method: 'cancelDouyuRenewal', args: { planId: 'obsolete' } })
    expect(named('executeDouyuRenewal')).toEqual([])
    expect(screen.getByRole('button', { name: '生成核对单' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '生成核对单' }))
    await screen.findByRole('region', { name: '赠送核对单' })
    expect(screen.getByRole('button', { name: '确认赠送' })).toBeEnabled()
  })

  it('retires an unexecuted plan when the page closes', async () => {
    const view = render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    view.unmount()
    expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }])
    expect(named('executeDouyuRenewal')).toEqual([])
  })

  it('stops remaining gifts when leaving the renewal pane to reach the write switch', async () => {
    const bridge = window.streamSyncer!
    const invoke = bridge.invoke
    let finish: ((value: unknown) => void) | undefined
    bridge.invoke = vi.fn((method: string, args: unknown) => {
      if (method === 'executeDouyuRenewal') {
        calls.push({ method, args })
        return new Promise(resolve => { finish = resolve })
      }
      return invoke(method as never, args as never)
    }) as StreamSyncerBridge['invoke']
    const view = render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    fireEvent.click(screen.getByRole('button', { name: '确认赠送' }))
    await waitFor(() => expect(finish).toBeDefined())
    view.unmount()
    expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }])
    await act(async () => { finish!({ ok: true, value: { planId: 'p1', status: 'cancelled', message: '', rows: [] } }) })
    expect(named('executeDouyuRenewal')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: '赠送处理结果' })).toBeNull()
  })

  it('splits like stock equally, shows what stays in the backpack and why rooms are skipped', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    fireEvent.click(screen.getByRole('button', { name: /粉丝牌/ }))
    await screen.findByRole('checkbox', { name: /房间 100/ })
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 100/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 200/ }))
    fireEvent.click(screen.getByRole('radio', { name: '同类库存均分' }))
    expect(screen.queryByRole('spinbutton', { name: '每个房间赠送数量' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '生成核对单' }))
    const plan = await screen.findByRole('region', { name: '赠送核对单' })
    expect(named('previewDouyuRenewalEqual')).toEqual([{ method: 'previewDouyuRenewalEqual', args: { accountId: 'a1', rooms: ['100', '200'] } }])
    expect(named('previewDouyuRenewal')).toEqual([])
    expect(plan.textContent).toContain('留在背包：荧光棒 × 1')
    expect(plan.textContent).toContain('跳过：没有可核对的普通背包荧光棒，本次跳过')

    // Switching the allocation is an edit like any other.
    fireEvent.click(screen.getByRole('radio', { name: '统一数量' }))
    await waitFor(() => expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }]))
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
  })

  it('sends per-room quantities only in per-room mode', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    fireEvent.click(screen.getByRole('button', { name: /粉丝牌/ }))
    await screen.findByRole('checkbox', { name: /房间 100/ })
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 100/ }))
    expect(screen.queryByRole('spinbutton', { name: '房间 100 的赠送数量' })).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '逐房数量' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: '房间 100 的赠送数量' }), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: '生成核对单' }))
    await screen.findByRole('region', { name: '赠送核对单' })
    expect(named('previewDouyuRenewal')[0]!.args).toEqual({ accountId: 'a1', rooms: ['100'], quantity: 1, quantities: [{ room: '100', quantity: 4 }] })
  })

  it('sends one execute on a double click and never presses stop by accident', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    const confirm = screen.getByRole('button', { name: '确认赠送' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await screen.findByRole('region', { name: '赠送处理结果' })
    expect(named('executeDouyuRenewal')).toEqual([{ method: 'executeDouyuRenewal', args: { planId: 'p1' } }])
    expect(named('cancelDouyuRenewal')).toEqual([])
  })

  it('lists badge acquisition dates with unknown kept unknown', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    const section = screen.getByRole('region', { name: '粉丝牌获取日期' })
    fireEvent.click(within(section).getByRole('button', { name: '读取' }))
    await within(section).findByText('甲')
    const unknownRow = within(section).getByText('乙').closest('tr')!
    expect(within(unknownRow).getAllByText('未知')).toHaveLength(2)
    expect(within(within(section).getByText('甲').closest('tr')!).getByText('30 天')).toBeInTheDocument()
    expect(section.textContent).toContain('仅显示本次读取到的粉丝牌')
  })

  it('says what to do when the account is not signed in', () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready={false} />)
    expect(screen.getByText('请先登录 主号，登录后即可读取')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /粉丝牌/ })).toBeDisabled()
  })
})
