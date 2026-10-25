/**
 * Renewal gives away real items, so the rules that keep it honest are pinned here: only a
 * reviewed plan is executed, by id; any edit retires the plan; leaving retires it too.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
      if (method === 'executeDouyuRenewal') {
        const planId = (args as { planId: string }).planId
        return { ok: true, value: { planId, status: 'completed', message: '', rows: [] } }
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
  await screen.findByRole('region', { name: '赠送预览' })
}

describe('badge renewal', () => {
  it('executes the reviewed plan by id and nothing else', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    fireEvent.click(screen.getByRole('button', { name: '确认赠送' }))
    await screen.findByRole('region', { name: '赠送处理结果' })
    expect(named('executeDouyuRenewal')).toEqual([{ method: 'executeDouyuRenewal', args: { planId: 'p1' } }])
  })

  it('retires the plan when the selection changes, and cannot confirm the stale one', async () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    fireEvent.click(screen.getByRole('checkbox', { name: /房间 200/ }))
    await waitFor(() => expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }]))
    expect(screen.queryByRole('region', { name: '赠送预览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '确认赠送' })).toBeNull()
  })

  it('retires an unexecuted plan when the page closes', async () => {
    const view = render(<Renewal accountId="a1" accountLabel="主号" ready />)
    await toPlan()
    view.unmount()
    expect(named('cancelDouyuRenewal')).toEqual([{ method: 'cancelDouyuRenewal', args: { planId: 'p1' } }])
    expect(named('executeDouyuRenewal')).toEqual([])
  })

  it('says what to do when the account is not signed in', () => {
    render(<Renewal accountId="a1" accountLabel="主号" ready={false} />)
    expect(screen.getByText('请先登录 主号，登录后即可读取。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /粉丝牌/ })).toBeDisabled()
  })
})
