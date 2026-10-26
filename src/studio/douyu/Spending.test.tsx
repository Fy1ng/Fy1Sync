/**
 * This month's spending: amounts are fen shown as 元, and a total is only shown when the
 * main process proved one — never the ledgers added up here.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamSyncerBridge } from '../../../electron/contracts'
import type { DouyuMonthlySpending } from '../../../server/douyu/insightsTypes'
import { Spending } from './Spending'
import type { DouyuData } from './useDouyu'

let spending: DouyuMonthlySpending
const invoke = vi.fn()

const month = (patch: Partial<DouyuMonthlySpending> = {}): DouyuMonthlySpending => ({
  accountId: 'a1', checkedAt: 1, month: '2026-10', timeZone: 'Asia/Shanghai', currency: 'CNY', unit: 'fen',
  sources: [
    { source: 'gift-consumption', coverage: 'all-pages', pageCount: 2, entries: 3, amountMinor: 1234, reason: null,
      categories: [{ category: '礼物', amountMinor: 1234, entries: 3 }] },
    { source: 'diamond-fans', coverage: 'partial', pageCount: 1, entries: 1, amountMinor: 3000, reason: '分页未完成',
      categories: [{ category: '钻粉充值/续费', amountMinor: 3000, entries: 1 }] },
  ],
  totalMinor: null, aggregation: 'unreconciled', message: '',
  ...patch,
})

const dataFor = (loggedIn = true): DouyuData => ({
  active: { id: 'a1', label: '主号', active: true, busy: false, login: { loggedIn } },
}) as unknown as DouyuData

beforeEach(() => {
  spending = month()
  invoke.mockReset()
  invoke.mockImplementation(async () => ({ ok: true, value: spending }))
  vi.stubGlobal('streamSyncer', {
    invoke: invoke as unknown as StreamSyncerBridge['invoke'],
    subscribeDanmaku: () => () => {},
  } satisfies StreamSyncerBridge)
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('monthly spending', () => {
  it('reads on request and shows each ledger in 元 without inventing a total', async () => {
    render(<Spending data={dataFor()} />)
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '读取' }))
    const total = await screen.findByRole('group', { name: '本月合计' })
    expect(invoke).toHaveBeenCalledWith('getDouyuMonthlySpending', { accountId: 'a1' })
    expect(total).toHaveTextContent('不将其相加')
    expect(total).not.toHaveTextContent('42.34')
    const gift = screen.getByRole('group', { name: '礼物消费记录' })
    expect(within(gift).getAllByText('12.34 元')).toHaveLength(2)
    expect(gift).toHaveTextContent('已读取全部 2 页，共 3 笔')
    const diamond = screen.getByRole('group', { name: '钻粉充值记录' })
    expect(diamond).toHaveTextContent('仅读取部分 1 页，共 1 笔。分页未完成')
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  })

  it('shows the total only when the main process gives one', async () => {
    spending = month({ totalMinor: 4234, aggregation: 'complete' })
    render(<Spending data={dataFor()} />)
    fireEvent.click(screen.getByRole('button', { name: '读取' }))
    expect(await screen.findByRole('group', { name: '本月合计' })).toHaveTextContent('42.34 元')
  })

  it('needs a signed-in current account', () => {
    render(<Spending data={dataFor(false)} />)
    expect(screen.getByRole('button', { name: '读取' })).toBeDisabled()
    expect(screen.getByText('当前账号未登录，无法读取消费记录。')).toBeInTheDocument()
  })

  it('shows a read failure', async () => {
    invoke.mockImplementation(async () => ({ ok: false, code: 'unavailable', message: '消费记录读取失败' }))
    render(<Spending data={dataFor()} />)
    fireEvent.click(screen.getByRole('button', { name: '读取' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('消费记录读取失败')
  })
})
