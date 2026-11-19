import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ErrorText } from './ErrorDetails'

afterEach(cleanup)
describe('error detail controls', () => {
  it('renders ordinary prompts and repeated wrapped summaries as text alone', () => {
    render(<>
      <p><ErrorText error="内容不能为空" /></p>
      <p><ErrorText error={{ message: '未登录斗鱼账号' }} /></p>
      <p><ErrorText error={{ ok: false, detail: { message: '请重新载入片源' } }} message="请重新载入片源" /></p>
    </>)
    expect(screen.getByText('内容不能为空')).toBeInTheDocument()
    expect(screen.getByText('未登录斗鱼账号')).toBeInTheDocument()
    expect(screen.getByText('请重新载入片源')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '查看原始错误' })).toBeNull()
  })
  it('keeps details collapsed until requested and copies the redacted fields', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<p role="alert"><ErrorText error={{ message: '赛程暂时无法读取', detail: { status: 429, responseBody: 'Rate Limited', token: 'secret-value' } }} /></p>)
    expect(screen.queryByRole('region', { name: '原始错误信息' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    expect(screen.getByRole('region', { name: '原始错误信息' }).textContent).toContain('429')
    expect(screen.getByRole('region', { name: '原始错误信息' }).textContent).not.toContain('secret-value')
    fireEvent.click(screen.getByRole('button', { name: '复制错误信息' }))
    await screen.findByRole('button', { name: '已复制' })
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Rate Limited'))
    fireEvent.click(screen.getByRole('button', { name: '收起原始错误' }))
    expect(screen.queryByRole('region', { name: '原始错误信息' })).toBeNull()
  })
  it('keeps concurrent errors with equal summaries attached to their own source', () => {
    render(<><p><ErrorText error={{ message: '读取失败', detail: { status: 429 } }} /></p><p><ErrorText error={{ message: '读取失败', detail: { status: 503 } }} /></p></>)
    fireEvent.click(screen.getAllByRole('button', { name: '查看原始错误' })[1]!)
    const panel = screen.getByRole('region', { name: '原始错误信息' })
    expect(panel.textContent).toContain('503')
    expect(panel.textContent).not.toContain('429')
  })
  it('shows a manual copy fallback when clipboard access fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<ErrorText error={{ message: '读取失败', cause: { message: 'connection refused' } }} />)
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    fireEvent.click(screen.getByRole('button', { name: '复制错误信息' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败，可选择下方内容手动复制')
  })
})
