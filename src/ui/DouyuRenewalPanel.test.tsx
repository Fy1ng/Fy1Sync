import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient, type ApiResult } from '../app/apiClient'
import type { DouyuRenewalPlan, DouyuRenewalResult, DouyuRenewalTargetPage } from '../../server/douyu/renewalTypes'
import { DouyuRenewalPanel } from './DouyuRenewalPanel'

// Synthetic DTOs only. These tests never access live accounts or gift anything.
const ACCOUNT = 'synthetic-account'
const ok = <T,>(value: T): ApiResult<T> => ({ ok: true, value })
const target = (room: string) => ({ room, badgeName: `牌${room}` })
function page(rooms = ['100', '200', '300'], accountId = ACCOUNT): DouyuRenewalTargetPage {
  return { accountId, checkedAt: Date.now(), coverage: 'returned-page', targets: rooms.map(target), message: '本次返回页.' }
}
function plan(rooms = ['100', '200'], quantity = 1, id = 'synthetic-plan'): DouyuRenewalPlan {
  return { id, accountId: ACCOUNT, createdAt: Date.now(), expiresAt: Date.now() + 60_000, totalQuantity: rooms.length * quantity,
    rows: rooms.map((room, index) => ({ ...target(room), status: 'ready', reason: null,
      gift: { propId: 'synthetic-private-prop-id', name: '普通荧光棒', quantity, stock: 50, expiresAt: index === 0 ? null : Date.now() + 86_400_000 } })),
    message: '请确认所选房间和背包数量.' }
}
function result(current: DouyuRenewalPlan, status: DouyuRenewalResult['status'] = 'completed'): DouyuRenewalResult {
  return { planId: current.id, status, message: '赠送完成.', rows: current.rows.map(row => ({ room: row.room, badgeName: row.badgeName,
    propName: row.gift?.name ?? null, quantity: row.gift?.quantity ?? 0, status: row.status === 'ready' ? 'receipt-received' : 'skipped', message: '请核对背包库存.' })) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

let latestPlan: DouyuRenewalPlan
beforeEach(() => {
  let serial = 0
  latestPlan = plan()
  vi.spyOn(apiClient, 'getDouyuRenewalTargets').mockResolvedValue(ok(page()))
  vi.spyOn(apiClient, 'previewDouyuRenewal').mockImplementation(async input => {
    latestPlan = { ...plan(input.rooms, input.quantity, `synthetic-plan-${++serial}`), accountId: input.accountId }
    return ok(latestPlan)
  })
  vi.spyOn(apiClient, 'executeDouyuRenewal').mockImplementation(async () => ok(result(latestPlan)))
  vi.spyOn(apiClient, 'cancelDouyuRenewal').mockResolvedValue(ok({ cancelled: true }))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function open(props: Partial<React.ComponentProps<typeof DouyuRenewalPanel>> = {}) {
  const view = render(<DouyuRenewalPanel accountId={ACCOUNT} accountLabel="日常账号" {...props} />)
  fireEvent.click(screen.getByText('续牌赠送'))
  return view
}
const readButton = () => screen.getByRole('button', { name: '读取粉丝牌' })
const previewButton = () => screen.getByRole('button', { name: '生成赠送预览' })
const confirmButton = () => screen.getByRole('button', { name: '确认赠送' })
const quantityInput = () => screen.getByRole('spinbutton', { name: '每个房间赠送数量' })
const checkbox = (room: string) => screen.getByRole('checkbox', { name: `选择房间 ${room} (牌${room})` })
async function loadTargets() {
  fireEvent.click(readButton())
  await screen.findByRole('checkbox', { name: '选择房间 100 (牌100)' })
}
async function loadAndSelect(rooms = ['100', '200']) {
  await loadTargets()
  for (const room of rooms) fireEvent.click(checkbox(room))
}
async function makePreview(rooms = ['100', '200']) {
  await loadAndSelect(rooms)
  fireEvent.click(previewButton())
  await screen.findByRole('region', { name: '赠送预览' })
}

describe('explicit target reads and selection', () => {
  it('starts folded, reads nothing automatically and starts with no rooms selected', async () => {
    const view = render(<DouyuRenewalPanel accountId={ACCOUNT} accountLabel="日常账号" />)
    expect(view.container.querySelector('details')).not.toHaveAttribute('open')
    await act(async () => {})
    expect(apiClient.getDouyuRenewalTargets).not.toHaveBeenCalled()
    expect(apiClient.previewDouyuRenewal).not.toHaveBeenCalled()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('续牌赠送'))
    expect(apiClient.getDouyuRenewalTargets).not.toHaveBeenCalled()
    await loadTargets()
    expect(apiClient.getDouyuRenewalTargets).toHaveBeenCalledExactlyOnceWith(ACCOUNT)
    expect(screen.getAllByRole('checkbox', { checked: false })).toHaveLength(3)
    expect(quantityInput()).toHaveValue(1)
    expect(previewButton()).toBeDisabled()
    expect(screen.getByText(/仅显示本次返回页, 不代表全部粉丝牌/)).toBeVisible()
  })

  it('supports select-all for the returned page and clearing the selection', async () => {
    open()
    await loadTargets()
    fireEvent.click(screen.getByRole('button', { name: '全选本页' }))
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(3)
    expect(screen.getByText('已选择 3/20 个房间.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    expect(screen.getAllByRole('checkbox', { checked: false })).toHaveLength(3)
  })

  it('does not truncate an oversized page and permits at most 20 manual selections', async () => {
    const rooms = Array.from({ length: 21 }, (_, index) => String(100 + index))
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValue(ok(page(rooms)))
    open()
    await loadTargets()
    const selectAll = screen.getByRole('button', { name: '全选本页' })
    expect(selectAll).toBeDisabled()
    fireEvent.click(selectAll)
    expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0)
    expect(screen.getByText(/本页超过 20 个房间/)).toBeVisible()
    rooms.slice(0, 20).forEach(room => fireEvent.click(checkbox(room)))
    expect(checkbox('120')).toBeDisabled()
    fireEvent.click(checkbox('120'))
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(20)
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: rooms.slice(0, 20), quantity: 1 })
  })

  it.each(['', '0', '-1', '1.5', '1001'])('rejects invalid per-room quantity %s', async quantity => {
    open()
    await loadAndSelect()
    fireEvent.change(quantityInput(), { target: { value: quantity } })
    expect(screen.getByText('数量必须为 1 至 1000 的整数.')).toBeVisible()
    expect(previewButton()).toBeDisabled()
    fireEvent.click(previewButton())
    expect(apiClient.previewDouyuRenewal).not.toHaveBeenCalled()
  })

  it('accepts the explicit upper bound without mutating the chosen amount', async () => {
    vi.mocked(apiClient.previewDouyuRenewal).mockImplementation(async input => {
      latestPlan = plan(input.rooms, input.quantity)
      latestPlan.rows.forEach(row => { row.gift!.stock = 3000 })
      return ok(latestPlan)
    })
    open()
    await loadAndSelect(['100'])
    fireEvent.change(quantityInput(), { target: { value: '1000' } })
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: ['100'], quantity: 1000 })
  })

  it('does not turn a failed initial query into an empty target page', async () => {
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce({ ok: false, code: 'login-required', message: '请先登录斗鱼账号.' })
    open()
    fireEvent.click(readButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('请先登录斗鱼账号.')
    expect(screen.queryByText('本次返回页没有可选目标.')).not.toBeInTheDocument()
    expect(readButton()).toBeEnabled()
    await loadTargets()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retains the last returned page when a refresh fails and sanitizes exceptions', async () => {
    open()
    await loadTargets()
    vi.mocked(apiClient.getDouyuRenewalTargets).mockRejectedValueOnce(new Error('synthetic private raw response'))
    fireEvent.click(readButton())
    await screen.findByText('无法读取粉丝牌, 请稍后重试.')
    expect(checkbox('100')).toBeVisible()
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument()
    expect(screen.queryByText('本次返回页没有可选目标.')).not.toBeInTheDocument()
  })

  it('renders room names as text and never follows or inserts their markup', async () => {
    const unsafe = '<a href="https://example.test/">徽章</a>'
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValue(ok({ ...page(), targets: [{ room: '100', badgeName: unsafe }] }))
    const view = open()
    fireEvent.click(readButton())
    expect(await screen.findByText(`${unsafe} / 房间 100`)).toBeVisible()
    expect(view.container.querySelector('a')).toBeNull()
  })
})

describe('read-only previews and immutable confirmation', () => {
  it('shows existing stock and expiry without executing a preview', async () => {
    open()
    await makePreview()
    const preview = screen.getByRole('region', { name: '赠送预览' })
    expect(within(preview).getByText('计划使用 2 个现有背包道具, 赠送至 2 个房间.')).toBeVisible()
    expect(within(preview).getByText('道具到期: 永久')).toBeVisible()
    expect(within(preview).getAllByText('普通荧光棒 x 1, 读取时库存 50')).toHaveLength(2)
    expect(within(preview).getByText('赠送回执不等于续期效果已验证.')).toBeVisible()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
    expect(screen.queryByText(/synthetic-private-prop-id/)).not.toBeInTheDocument()
    expect(confirmButton()).toBeEnabled()
  })

  it('shows skipped plan reasons and disables confirmation when no gifts are ready', async () => {
    vi.mocked(apiClient.previewDouyuRenewal).mockImplementation(async input => ok({ ...plan(input.rooms, input.quantity), totalQuantity: 0,
      rows: input.rooms.map(room => ({ ...target(room), status: 'skipped', gift: null, reason: '没有可用的普通荧光棒' })) }))
    open()
    await makePreview()
    expect(screen.getAllByText('已跳过: 没有可用的普通荧光棒')).toHaveLength(2)
    expect(confirmButton()).toBeDisabled()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it('binds confirmation only to the reviewed planId and blocks duplicate clicks', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    open()
    await makePreview()
    const reviewed = latestPlan
    const confirm = confirmButton()
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    expect(apiClient.executeDouyuRenewal).toHaveBeenCalledExactlyOnceWith(reviewed.id)
    expect(confirm).toBeDisabled()
    expect(quantityInput()).toBeDisabled()
    expect(screen.queryByRole('region', { name: '赠送处理结果' })).not.toBeInTheDocument()
    await act(async () => { pending.resolve(ok(result(reviewed))) })
    expect(screen.getByText('赠送处理完成')).toBeVisible()
    expect(confirmButton()).toBeDisabled()
  })

  it.each(['quantity', 'selection'] as const)('invalidates the previous plan after changing %s', async kind => {
    open()
    await makePreview()
    const oldId = latestPlan.id
    if (kind === 'quantity') fireEvent.change(quantityInput(), { target: { value: '2' } })
    else fireEvent.click(checkbox('100'))
    expect(screen.queryByRole('button', { name: '确认赠送' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(oldId)
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(latestPlan.id).not.toBe(oldId)
    expect(confirmButton()).toBeEnabled()
  })

  it('discards a preview that finishes after configuration changes', async () => {
    const pending = deferred<ApiResult<DouyuRenewalPlan>>()
    vi.mocked(apiClient.previewDouyuRenewal).mockReturnValueOnce(pending.promise)
    open()
    await loadAndSelect()
    fireEvent.click(previewButton())
    fireEvent.change(quantityInput(), { target: { value: '3' } })
    await act(async () => { pending.resolve(ok(plan())) })
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith('synthetic-plan')
    expect(previewButton()).toBeEnabled()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it('expires a preview without automatically refreshing or executing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 24, 10))
    open()
    await act(async () => { fireEvent.click(readButton()) })
    fireEvent.click(checkbox('100'))
    await act(async () => { fireEvent.click(previewButton()) })
    expect(confirmButton()).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.getByText('赠送预览已过期, 请重新生成预览.')).toBeVisible()
    expect(confirmButton()).toBeDisabled()
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledOnce()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it.each(['ready', 'pending'] as const)('cancels a %s preview without a gift submission', async phase => {
    const pending = deferred<ApiResult<DouyuRenewalPlan>>()
    if (phase === 'pending') vi.mocked(apiClient.previewDouyuRenewal).mockReturnValueOnce(pending.promise)
    open()
    await loadAndSelect()
    fireEvent.click(previewButton())
    if (phase === 'ready') await screen.findByRole('region', { name: '赠送预览' })
    fireEvent.click(screen.getByRole('button', { name: '取消预览' }))
    if (phase === 'pending') await act(async () => { pending.resolve(ok(plan())) })
    expect(screen.getByText('赠送预览已取消.')).toBeVisible()
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledOnce()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it('rejects an account-mismatched preview instead of enabling confirmation', async () => {
    vi.mocked(apiClient.previewDouyuRenewal).mockResolvedValueOnce(ok({ ...plan(), accountId: 'another-account' }))
    open()
    await loadAndSelect()
    fireEvent.click(previewButton())
    await screen.findByText('无法生成赠送预览, 请稍后重试.')
    expect(screen.queryByRole('button', { name: '确认赠送' })).not.toBeInTheDocument()
  })
})

describe('partial results and explicit stopping', () => {
  it('shows all structured row states and never claims renewal was verified', async () => {
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok(page(['100', '200', '300', '400'])))
    vi.mocked(apiClient.executeDouyuRenewal).mockImplementationOnce(async () => ok({ ...result(latestPlan, 'waiting-user'), message: '续牌成功', reason: 'plan-changed',
      rows: latestPlan.rows.map((row, index) => ({ ...target(row.room), propName: '普通荧光棒', quantity: 1,
        status: (['receipt-received', 'unknown', 'not-submitted', 'skipped'] as const)[index]!, message: '库存和赠送回执请逐项核对.' })) }))
    open()
    await makePreview(['100', '200', '300', '400'])
    fireEvent.click(confirmButton())
    const results = await screen.findByRole('region', { name: '赠送处理结果' })
    expect(within(results).getByText(/^收到赠送回执/)).toBeVisible()
    expect(within(results).getByText(/^需要核对/)).toBeVisible()
    expect(within(results).getByText(/^未提交/)).toBeVisible()
    expect(within(results).getByText(/^已跳过/)).toBeVisible()
    expect(within(results).getByText('赠送结果需要核对')).toBeVisible()
    expect(within(results).getByText('预览已过期或目标与库存已变化, 请重新生成预览.')).toBeVisible()
    expect(screen.queryByText(/续牌成功/)).not.toBeInTheDocument()
    expect(apiClient.executeDouyuRenewal).toHaveBeenCalledOnce()
    expect(confirmButton()).toBeDisabled()
  })

  it('clears old results when generating a new preview without automatically retrying gifts', async () => {
    open()
    await makePreview()
    fireEvent.click(confirmButton())
    await screen.findByRole('region', { name: '赠送处理结果' })
    const pending = deferred<ApiResult<DouyuRenewalPlan>>()
    vi.mocked(apiClient.previewDouyuRenewal).mockReturnValueOnce(pending.promise)
    fireEvent.click(previewButton())
    expect(screen.queryByRole('region', { name: '赠送处理结果' })).not.toBeInTheDocument()
    await act(async () => { pending.resolve(ok(plan())) })
    expect(apiClient.executeDouyuRenewal).toHaveBeenCalledOnce()
  })

  it('stops once, waits for structured execution results and shows the partial completion', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    open()
    await makePreview()
    const reviewed = latestPlan
    fireEvent.click(confirmButton())
    const stop = screen.getByRole('button', { name: '停止赠送' })
    act(() => { fireEvent.click(stop); fireEvent.click(stop) })
    await screen.findByText('已请求停止, 正在等待赠送处理结果.')
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(reviewed.id)
    expect(screen.queryByRole('region', { name: '赠送处理结果' })).not.toBeInTheDocument()
    const cancelled = result(reviewed, 'cancelled')
    cancelled.rows[1]!.status = 'not-submitted'
    await act(async () => { pending.resolve(ok(cancelled)) })
    const results = screen.getByRole('region', { name: '赠送处理结果' })
    expect(within(results).getByText('已停止剩余赠送')).toBeVisible()
    expect(within(results).getByText(/^收到赠送回执/)).toBeVisible()
    expect(within(results).getByText(/^未提交/)).toBeVisible()
    expect(apiClient.executeDouyuRenewal).toHaveBeenCalledOnce()
  })

  it('keeps stop available when parent account controls become disabled', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    const view = open()
    await makePreview()
    fireEvent.click(confirmButton())
    view.rerender(<DouyuRenewalPanel accountId={ACCOUNT} accountLabel="日常账号" disabled />)
    const stop = screen.getByRole('button', { name: '停止赠送' })
    expect(stop).toBeEnabled()
    fireEvent.click(stop)
    await waitFor(() => expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledOnce())
    await act(async () => { pending.resolve(ok(result(latestPlan, 'cancelled'))) })
  })

  it('does not replace execution results with a late cancellation response', async () => {
    const executing = deferred<ApiResult<DouyuRenewalResult>>()
    const cancelling = deferred<ApiResult<{ cancelled: boolean }>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(executing.promise)
    vi.mocked(apiClient.cancelDouyuRenewal).mockReturnValueOnce(cancelling.promise)
    open()
    await makePreview()
    fireEvent.click(confirmButton())
    fireEvent.click(screen.getByRole('button', { name: '停止赠送' }))
    await act(async () => { executing.resolve(ok(result(latestPlan))) })
    await act(async () => { cancelling.resolve(ok({ cancelled: true })) })
    expect(screen.getByText('赠送处理完成')).toBeVisible()
    expect(screen.queryByText('已请求停止, 正在等待赠送处理结果.')).not.toBeInTheDocument()
  })

  it('sanitizes execution exceptions and requires a new preview before any further attempt', async () => {
    vi.mocked(apiClient.executeDouyuRenewal).mockRejectedValueOnce(new Error('synthetic private hc cookie response'))
    open()
    await makePreview()
    fireEvent.click(confirmButton())
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('赠送结果尚无法确认.')
    expect(screen.queryByText(/synthetic private/)).not.toBeInTheDocument()
    expect(confirmButton()).toBeDisabled()
    expect(apiClient.executeDouyuRenewal).toHaveBeenCalledOnce()
  })
})

describe('account changes and panel lifetime', () => {
  it.each([{ accountId: null }, { disabled: true }])('does not start queries or previews with unavailable account controls %#', props => {
    open(props)
    expect(readButton()).toBeDisabled()
    expect(previewButton()).toBeDisabled()
    expect(apiClient.getDouyuRenewalTargets).not.toHaveBeenCalled()
  })

  it('disables an existing preview confirmation while the parent is busy', async () => {
    const view = open()
    await makePreview()
    view.rerender(<DouyuRenewalPanel accountId={ACCOUNT} accountLabel="日常账号" disabled />)
    expect(confirmButton()).toBeDisabled()
    expect(previewButton()).toBeDisabled()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it('retires a previous account preview and clears its selections and quantity', async () => {
    const view = open()
    await makePreview()
    const oldPlanId = latestPlan.id
    view.rerender(<DouyuRenewalPanel accountId="another-account" accountLabel="比赛账号" />)
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(quantityInput()).toHaveValue(1)
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(oldPlanId)
    expect(screen.getByText('当前账号: 比赛账号')).toBeVisible()
    expect(apiClient.getDouyuRenewalTargets).toHaveBeenCalledOnce()
  })

  it('drops a targets response that arrives for the previous account', async () => {
    const pending = deferred<ApiResult<DouyuRenewalTargetPage>>()
    vi.mocked(apiClient.getDouyuRenewalTargets).mockReturnValueOnce(pending.promise)
    const view = open()
    fireEvent.click(readButton())
    view.rerender(<DouyuRenewalPanel accountId="another-account" accountLabel="比赛账号" />)
    await act(async () => { pending.resolve(ok(page())) })
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(readButton()).toBeEnabled()
  })

  it('cancels an old execution on account change and ignores its late structured result', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    const view = open()
    await makePreview()
    const reviewed = latestPlan
    fireEvent.click(confirmButton())
    view.rerender(<DouyuRenewalPanel accountId="another-account" accountLabel="比赛账号" />)
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(reviewed.id)
    await act(async () => { pending.resolve(ok(result(reviewed))) })
    expect(screen.queryByRole('region', { name: '赠送处理结果' })).not.toBeInTheDocument()
    expect(screen.queryByText('赠送处理完成')).not.toBeInTheDocument()
    expect(screen.getByText('当前账号: 比赛账号')).toBeVisible()
  })

  it('cancels an executing plan on unmount and ignores its response', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    const view = open()
    await makePreview()
    const reviewed = latestPlan
    fireEvent.click(confirmButton())
    view.unmount()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(reviewed.id)
    await act(async () => { pending.resolve(ok(result(reviewed))) })
    expect(screen.queryByText('赠送处理完成')).not.toBeInTheDocument()
  })

  it('does not duplicate a pending stop request when the panel unmounts', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    const cancelling = deferred<ApiResult<{ cancelled: boolean }>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    vi.mocked(apiClient.cancelDouyuRenewal).mockReturnValueOnce(cancelling.promise)
    const view = open()
    await makePreview()
    fireEvent.click(confirmButton())
    fireEvent.click(screen.getByRole('button', { name: '停止赠送' }))
    view.unmount()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledOnce()
    await act(async () => { cancelling.resolve(ok({ cancelled: true })); pending.resolve(ok(result(latestPlan, 'cancelled'))) })
  })

  it('keeps an explicitly confirmed execution running when only the details are folded', async () => {
    const pending = deferred<ApiResult<DouyuRenewalResult>>()
    vi.mocked(apiClient.executeDouyuRenewal).mockReturnValueOnce(pending.promise)
    const view = open()
    await makePreview()
    fireEvent.click(confirmButton())
    fireEvent.click(screen.getByText('续牌赠送'))
    expect(view.container.querySelector('details')).not.toHaveAttribute('open')
    expect(apiClient.cancelDouyuRenewal).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(ok(result(latestPlan))) })
  })
})
