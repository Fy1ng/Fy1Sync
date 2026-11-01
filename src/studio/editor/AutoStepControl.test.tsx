import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AutoStepControl, type AutoStepControlProps } from './AutoStepControl'

afterEach(cleanup)

function controlProps(overrides: Partial<AutoStepControlProps> = {}): AutoStepControlProps {
  return { running: false, canStart: true, steps: 0, onStart: vi.fn(), onStop: vi.fn(), ...overrides }
}

describe('automatic second-step control', () => {
  it('disables start until the current frame is ready without adding a manual input', () => {
    const props = controlProps({ canStart: false })
    render(<AutoStepControl {...props} />)
    const start = screen.getByRole('button', { name: '自动 +1s' })
    expect(start).toBeDisabled()
    fireEvent.click(start)
    expect(props.onStart).not.toHaveBeenCalled()
    expect(props.onStop).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('starts only through the start callback and explains sequential processing', () => {
    const props = controlProps()
    render(<AutoStepControl {...props} />)
    const start = screen.getByRole('button', { name: '自动 +1s' })
    expect(screen.getByRole('group', { name: '自动逐秒标注' })).toContainElement(start)
    expect(start).toHaveAttribute('title', expect.stringContaining('完成当前帧处理后再继续'))
    fireEvent.click(start)
    expect(props.onStart).toHaveBeenCalledTimes(1)
    expect(props.onStop).not.toHaveBeenCalled()
  })

  it('always keeps stop enabled while running even if another step cannot start', () => {
    const props = controlProps({ running: true, canStart: false, steps: 2 })
    render(<AutoStepControl {...props} />)
    const stop = screen.getByRole('button', { name: '停止自动 +1s' })
    expect(stop).toBeEnabled()
    fireEvent.click(stop)
    expect(props.onStop).toHaveBeenCalledTimes(1)
    expect(props.onStart).not.toHaveBeenCalled()
  })

  it('switches callbacks with the running state while retaining completed counts', () => {
    const props = controlProps()
    const { rerender } = render(<AutoStepControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '自动 +1s' }))
    rerender(<AutoStepControl {...props} running steps={5} />)
    fireEvent.click(screen.getByRole('button', { name: '停止自动 +1s' }))
    rerender(<AutoStepControl {...props} steps={5} canStart={false} />)
    expect(props.onStart).toHaveBeenCalledTimes(1)
    expect(props.onStop).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '自动 +1s' })).toBeDisabled()
    expect(screen.getByText('已处理 5 帧')).toBeVisible()
  })

  it('shows zero processed frames only during a running session', () => {
    const props = controlProps()
    const { rerender } = render(<AutoStepControl {...props} />)
    expect(screen.queryByText('已处理 0 帧')).not.toBeInTheDocument()
    rerender(<AutoStepControl {...props} running />)
    expect(screen.getByText('已处理 0 帧')).toBeVisible()
    rerender(<AutoStepControl {...props} running steps={1} />)
    expect(screen.getByText('已处理 1 帧')).toBeVisible()
    expect(screen.queryByText('已处理 0 帧')).not.toBeInTheDocument()
  })
})
