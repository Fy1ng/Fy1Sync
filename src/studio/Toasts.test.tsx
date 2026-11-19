import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Notice } from '../app/session'
import { Toasts } from './Toasts'

const state = vi.hoisted(() => ({ notices: [] as Notice[], session: { dismissNotice: vi.fn() } }))
vi.mock('../app/SessionContext', () => ({ useSession: () => state.session, useSessionSnapshot: () => state }))
afterEach(() => { cleanup(); vi.useRealTimers(); state.session.dismissNotice.mockClear() })

describe('error notifications', () => {
  it('does not add a diagnostic action to warnings or errors without additional details', () => {
    state.notices = [
      { id: 3, kind: 'warn', text: '缓冲不足，未完全调整', at: 3 },
      { id: 2, kind: 'error', text: '读取失败', at: 2, detail: { message: '读取失败' } },
      { id: 1, kind: 'info', text: '已载入', at: 1 },
    ]
    render(<Toasts />)
    expect(screen.getAllByRole('button', { name: '关闭提示' })).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '查看原始错误' })).toBeNull()
  })
  it('keeps an expanded warning available while its original fields are being read', () => {
    vi.useFakeTimers()
    state.notices = [{ id: 1, kind: 'warn', text: '读取失败', at: 1, detail: { status: 429 } }]
    render(<Toasts />)
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    act(() => { vi.advanceTimersByTime(10000) })
    expect(state.session.dismissNotice).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '收起原始错误' }))
    act(() => { vi.advanceTimersByTime(9000) })
    expect(state.session.dismissNotice).toHaveBeenCalledWith(1)
  })
  it('keeps different causes with the same summary separate and displays the latest notices', () => {
    state.notices = [4, 3, 2, 1].map(id => ({ id, kind: 'error', text: '读取失败', at: id, detail: { status: 500 + id } }))
    render(<Toasts />)
    const buttons = screen.getAllByRole('button', { name: '查看原始错误' })
    expect(buttons).toHaveLength(3)
    fireEvent.click(buttons[0]!)
    expect(screen.getByRole('region', { name: '原始错误信息' }).textContent).toContain('504')
  })
})
