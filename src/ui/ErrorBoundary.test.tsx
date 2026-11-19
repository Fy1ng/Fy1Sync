import { render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

it('names the preference reset action that is available in the crash screen', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  function Broken(): never { throw new Error('test render failure') }
  try {
    render(<ErrorBoundary><Broken /></ErrorBoundary>)
    const crash = screen.getByRole('alert')
    const reset = within(crash).getByRole('button', { name: '清除偏好并刷新' })
    expect(crash).toHaveTextContent(`点击「${reset.textContent}」`)
    expect(crash).not.toHaveTextContent('在设置里清除')
  } finally { log.mockRestore() }
})
