import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ErrorActionRow, ErrorText } from './ErrorDetails'

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

  it('suppresses raw error toggle for self-explanatory A1-A15 outcomes while keeping B1-B11 inspectable', () => {
    const basicCases = [
      { code: 'not-live', message: '直播当前未开始', detail: { code: 102 } },
      { code: 'room-not-found', message: '未找到该直播间', detail: { code: 1 } },
      { code: 'unsupported-url', message: '无法识别该地址', hint: '请检查输入' },
      { code: 'login-required', message: '需要登录', detail: { code: -101 } },
      { code: 'restricted', reason: 'bot-check', message: 'YouTube 要求验证不是机器人', detail: { code: 'bot-check' } },
      { code: 'restricted', reason: 'geo-restricted', message: '所在地区不可观看', detail: { reason: 'geo-restricted' } },
      { code: 'restricted', reason: 'room-banned', message: '直播间正在整改', detail: { reason: 'room-banned' } },
      { code: 'upstream-error', reason: 'socks4-unsupported', message: '不支持 SOCKS4', detail: { code: 'socks4-unsupported' } },
      { code: 'upstream-error', reason: 'media-network-boundary', message: '未授权局域网', detail: { code: 'media-network-boundary' } },
      { kind: 'no-samples', message: '尚未读到倒计时' },
      { kind: 'rejected', reason: 'no-official-jump', message: '尚未识别稳定跳变' },
      { code: 'browser-import-browser-in-use', message: '浏览器正在使用中' },
      { code: 'chrome-not-found', message: '未找到 Chrome' },
    ]
    for (const err of basicCases) {
      render(<ErrorText error={err} message={err.message} />)
      expect(screen.queryByRole('button', { name: '查看原始错误' })).toBeNull()
      cleanup()
    }

    render(
      <ErrorActionRow error={{ code: 'upstream-error', stage: 'proxy', reason: 'proxy-unreachable', message: '无法连接代理', detail: { errno: 'ECONNREFUSED' } }} summary="无法连接代理">
        <button type="button">网络设置</button>
        <button type="button">重试</button>
      </ErrorActionRow>,
    )
    const row = screen.getByRole('button', { name: '网络设置' }).parentElement!
    expect(row).toHaveClass('error-action-row')
    expect(row).toContainElement(screen.getByRole('button', { name: '重试' }))
    expect(row).toContainElement(screen.getByRole('button', { name: '查看原始错误' }))
    fireEvent.click(screen.getByRole('button', { name: '查看原始错误' }))
    expect(row).not.toContainElement(screen.getByRole('region', { name: '原始错误信息' }))
    expect(screen.getByRole('region', { name: '原始错误信息' }).textContent).toContain('ECONNREFUSED')
  })
})
