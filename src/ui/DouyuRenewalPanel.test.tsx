import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
    for (const row of latestPlan.rows) row.gift!.quantity = input.quantities?.find(value => value.room === row.room)?.quantity ?? input.quantity
    latestPlan.totalQuantity = latestPlan.rows.reduce((sum, row) => sum + row.gift!.quantity, 0)
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
const roomQuantityInput = (room: string) => screen.getByRole('spinbutton', { name: `房间 ${room} 的赠送数量` })
const filterInput = () => screen.getByRole('searchbox', { name: '筛选粉丝牌' })
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

  it('supports selecting all filtered results and clearing the selection', async () => {
    open()
    await loadTargets()
    fireEvent.click(screen.getByRole('button', { name: '全选筛选结果' }))
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
    const selectAll = screen.getByRole('button', { name: '全选筛选结果' })
    expect(selectAll).toBeDisabled()
    fireEvent.click(selectAll)
    expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0)
    expect(screen.getByText(/全选当前筛选结果后将超过 20 个房间/)).toBeVisible()
    rooms.slice(0, 20).forEach(room => fireEvent.click(checkbox(room)))
    expect(checkbox('120')).toBeDisabled()
    fireEvent.click(checkbox('120'))
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(20)
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: rooms.slice(0, 20), quantity: 1 })
  })

  it('filters by room and available badge name while preserving hidden selections', async () => {
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok({ ...page(), targets: [target('100'), { room: '200', badgeName: 'RainBadge' }, target('300')] }))
    open()
    await loadTargets()
    fireEvent.click(checkbox('100'))
    fireEvent.change(filterInput(), { target: { value: '  rainBADGE  ' } })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    expect(screen.getByText('RainBadge / 房间 200')).toBeVisible()
    expect(screen.getByText(/另有 1 个已选房间在筛选结果外, 仍会加入预览/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '全选筛选结果' }))
    expect(screen.getByText('已选择 2/20 个房间.')).toBeVisible()
    fireEvent.change(filterInput(), { target: { value: '300' } })
    expect(checkbox('300')).not.toBeChecked()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(filterInput()).toHaveValue('')
    expect(checkbox('100')).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '选择房间 200 (RainBadge)' })).toBeChecked()
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: ['100', '200'], quantity: 1 })
  })

  it('includes hidden selections in the bulk-selection limit and never silently truncates', async () => {
    const matchingRooms = Array.from({ length: 20 }, (_, index) => String(200 + index))
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok({ ...page(), targets: [target('100'), ...matchingRooms.map(room => ({ room, badgeName: `比赛${room}` }))] }))
    open()
    await loadTargets()
    fireEvent.click(checkbox('100'))
    fireEvent.change(filterInput(), { target: { value: '比赛' } })
    const selectAll = screen.getByRole('button', { name: '全选筛选结果' })
    expect(screen.getAllByRole('checkbox')).toHaveLength(20)
    expect(selectAll).toBeDisabled()
    fireEvent.click(selectAll)
    expect(screen.getByText('已选择 1/20 个房间.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    expect(selectAll).toBeEnabled()
    fireEvent.click(selectAll)
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(20)
    expect(screen.getByText('已选择 20/20 个房间.')).toBeVisible()
  })

  it('distinguishes an unmatched search from an empty target response', async () => {
    const view = open()
    await loadAndSelect(['100'])
    fireEvent.change(filterInput(), { target: { value: 'does-not-match' } })
    expect(screen.getByText('没有匹配的粉丝牌, 请尝试其它房间号或徽章名.')).toBeVisible()
    expect(screen.queryByText('本次返回页没有可选目标.')).not.toBeInTheDocument()
    expect(screen.getByText('已选择 1/20 个房间.')).toBeVisible()
    expect(previewButton()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }))
    expect(previewButton()).toBeDisabled()
    view.unmount()
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok(page([])))
    open()
    fireEvent.click(readButton())
    expect(await screen.findByText('本次返回页没有可选目标.')).toBeVisible()
    expect(screen.queryByText('没有匹配的粉丝牌, 请尝试其它房间号或徽章名.')).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  it('keeps filtered selection controls usable from the keyboard', async () => {
    const user = userEvent.setup()
    open()
    await loadTargets()
    await user.click(filterInput())
    await user.type(filterInput(), '牌100')
    await user.tab()
    expect(screen.getByRole('button', { name: '全选筛选结果' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(checkbox('100')).toBeChecked()
    expect(roomQuantityInput('100')).toBeEnabled()
    checkbox('100').focus()
    await user.keyboard('[Space]')
    expect(checkbox('100')).not.toBeChecked()
    expect(roomQuantityInput('100')).toBeDisabled()
  })

  it.each([
    { coverage: 'all-pages' as const, pageCount: 2, text: '已读取全部 2 页粉丝牌目标, 共 3 个房间.' },
    { coverage: 'all-pages' as const, text: '已读取全部粉丝牌目标, 共 3 个房间.' },
    { coverage: 'official-snapshot' as const, text: '显示官方当前粉丝牌快照, 不代表已确认全部粉丝牌.' },
  ])('labels the reported $coverage coverage without assuming a returned page is complete', async ({ text, ...coverage }) => {
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok({ ...page(), ...coverage }))
    open()
    await loadTargets()
    expect(screen.getByText(text)).toBeVisible()
    expect(screen.queryByText('仅显示本次返回页, 不代表全部粉丝牌.')).not.toBeInTheDocument()
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

  it('previews selected room overrides with the default for all other selected rooms', async () => {
    open()
    await loadAndSelect(['100', '200', '300'])
    fireEvent.change(quantityInput(), { target: { value: '2' } })
    fireEvent.change(roomQuantityInput('100'), { target: { value: '5' } })
    fireEvent.change(roomQuantityInput('200'), { target: { value: '7' } })
    fireEvent.click(checkbox('200'))
    fireEvent.click(previewButton())
    const preview = await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: ['100', '300'], quantity: 2,
      quantities: [{ room: '100', quantity: 5 }] })
    expect(within(preview).getByText('计划使用 7 个现有背包道具, 赠送至 2 个房间.')).toBeVisible()
    expect(within(preview).getByText('普通荧光棒 x 5, 读取时库存 50')).toBeVisible()
    expect(within(preview).getByText('普通荧光棒 x 2, 读取时库存 50')).toBeVisible()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
  })

  it('returns a cleared override to the default without sending an empty override list', async () => {
    open()
    await loadAndSelect()
    fireEvent.change(roomQuantityInput('100'), { target: { value: '5' } })
    fireEvent.change(roomQuantityInput('100'), { target: { value: '' } })
    fireEvent.change(quantityInput(), { target: { value: '3' } })
    expect(roomQuantityInput('100')).toHaveAttribute('placeholder', '默认 3')
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: ['100', '200'], quantity: 3 })
  })

  it.each(['0', '-1', '1.5', '1001'])('blocks invalid selected room overrides even when filtered out: %s', async value => {
    open()
    await loadAndSelect()
    fireEvent.change(roomQuantityInput('100'), { target: { value } })
    expect(roomQuantityInput('100')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('请输入 1 至 1000 的整数, 或留空使用默认值.')).toBeVisible()
    fireEvent.change(filterInput(), { target: { value: '200' } })
    expect(screen.getByRole('alert')).toHaveTextContent('有 1 个已选房间的自定义数量无效')
    expect(previewButton()).toBeDisabled()
    fireEvent.click(previewButton())
    expect(apiClient.previewDouyuRenewal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    fireEvent.click(checkbox('100'))
    expect(previewButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledExactlyOnceWith({ accountId: ACCOUNT, rooms: ['200'], quantity: 1 })
  })

  it('preserves valid selections and room quantities on refresh, retires the plan and drops removed rooms', async () => {
    open()
    await loadAndSelect()
    fireEvent.change(quantityInput(), { target: { value: '2' } })
    fireEvent.change(roomQuantityInput('100'), { target: { value: '3' } })
    fireEvent.change(roomQuantityInput('200'), { target: { value: '9' } })
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    const previousPlan = latestPlan.id
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok(page(['100', '300'])))
    fireEvent.click(readButton())
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    await screen.findByText('粉丝牌已刷新, 保留 1 个仍在名单中的已选房间. 请重新生成赠送预览.')
    expect(checkbox('100')).toBeChecked()
    expect(checkbox('300')).not.toBeChecked()
    expect(roomQuantityInput('100')).toHaveValue(3)
    expect(quantityInput()).toHaveValue(2)
    expect(screen.queryByRole('spinbutton', { name: '房间 200 的赠送数量' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(previousPlan)
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledOnce()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(apiClient.previewDouyuRenewal).toHaveBeenLastCalledWith({ accountId: ACCOUNT, rooms: ['100'], quantity: 2, quantities: [{ room: '100', quantity: 3 }] })
    fireEvent.click(readButton())
    await screen.findByRole('checkbox', { name: '选择房间 200 (牌200)' })
    expect(checkbox('200')).not.toBeChecked()
    expect(roomQuantityInput('200')).toHaveValue(null)
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
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

  it('retains the last page and quantities when a refresh fails, but never restores the retired preview', async () => {
    open()
    await loadAndSelect()
    fireEvent.change(roomQuantityInput('100'), { target: { value: '7' } })
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    const previousPlan = latestPlan.id
    vi.mocked(apiClient.getDouyuRenewalTargets).mockRejectedValueOnce(new Error('synthetic private raw response'))
    fireEvent.click(readButton())
    await screen.findByText('无法读取粉丝牌, 请稍后重试.')
    expect(checkbox('100')).toBeChecked()
    expect(checkbox('200')).toBeChecked()
    expect(roomQuantityInput('100')).toHaveValue(7)
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(previousPlan)
    expect(apiClient.previewDouyuRenewal).toHaveBeenCalledOnce()
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
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

  it.each(['quantity', 'selection', 'room-quantity'] as const)('invalidates the previous plan after changing %s', async kind => {
    open()
    await makePreview()
    const oldId = latestPlan.id
    if (kind === 'quantity') fireEvent.change(quantityInput(), { target: { value: '2' } })
    else if (kind === 'room-quantity') fireEvent.change(roomQuantityInput('100'), { target: { value: '3' } })
    else fireEvent.click(checkbox('100'))
    expect(screen.queryByRole('button', { name: '确认赠送' })).not.toBeInTheDocument()
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(oldId)
    expect(apiClient.executeDouyuRenewal).not.toHaveBeenCalled()
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    expect(latestPlan.id).not.toBe(oldId)
    expect(confirmButton()).toBeEnabled()
  })

  it.each(['default', 'room'] as const)('discards a preview that finishes after changing the %s quantity', async kind => {
    const pending = deferred<ApiResult<DouyuRenewalPlan>>()
    vi.mocked(apiClient.previewDouyuRenewal).mockReturnValueOnce(pending.promise)
    open()
    await loadAndSelect()
    fireEvent.click(previewButton())
    fireEvent.change(kind === 'default' ? quantityInput() : roomQuantityInput('100'), { target: { value: '3' } })
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

  it('retires a previous account preview and clears its selections, search and all quantities', async () => {
    const view = open()
    await loadAndSelect()
    fireEvent.change(quantityInput(), { target: { value: '2' } })
    fireEvent.change(roomQuantityInput('100'), { target: { value: '7' } })
    fireEvent.change(filterInput(), { target: { value: '牌100' } })
    fireEvent.click(previewButton())
    await screen.findByRole('region', { name: '赠送预览' })
    const oldPlanId = latestPlan.id
    view.rerender(<DouyuRenewalPanel accountId="another-account" accountLabel="比赛账号" />)
    expect(screen.queryByRole('region', { name: '赠送预览' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(quantityInput()).toHaveValue(1)
    expect(apiClient.cancelDouyuRenewal).toHaveBeenCalledExactlyOnceWith(oldPlanId)
    expect(screen.getByText('当前账号: 比赛账号')).toBeVisible()
    expect(apiClient.getDouyuRenewalTargets).toHaveBeenCalledOnce()
    vi.mocked(apiClient.getDouyuRenewalTargets).mockResolvedValueOnce(ok(page(['100', '200', '300'], 'another-account')))
    await loadTargets()
    expect(filterInput()).toHaveValue('')
    expect(screen.getAllByRole('checkbox', { checked: false })).toHaveLength(3)
    expect(roomQuantityInput('100')).toHaveValue(null)
    expect(roomQuantityInput('100')).toBeDisabled()
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
