/** What a panel last read comes back when it reopens, per key, never under another key. */
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { forget, remember, remembered, useRemembered } from './remembered'

function Probe({ id }: { id: string | null }): React.ReactNode {
  const [value, setValue] = useRemembered<string>(id === null ? null : `probe:${id}`, 'empty')
  return <button type="button" onClick={() => setValue(`read ${id}`)}>{value}</button>
}

describe('useRemembered', () => {
  it('shows the last value when the panel mounts again', () => {
    const first = render(<Probe id="a" />)
    act(() => screen.getByRole('button').click())
    expect(screen.getByRole('button')).toHaveTextContent('read a')
    first.unmount()
    render(<Probe id="a" />)
    expect(screen.getByRole('button')).toHaveTextContent('read a')
  })

  it("never shows one key's value under another, even for one render", () => {
    remember('probe:a', 'read a')
    const seen: string[] = []
    function Spy({ id }: { id: string }): React.ReactNode {
      const [value] = useRemembered<string>(`probe:${id}`, 'empty')
      seen.push(`${id}=${value}`)
      return null
    }
    const view = render(<Spy id="a" />)
    view.rerender(<Spy id="b" />)
    expect(seen).not.toContain('b=read a')
    expect(seen.at(-1)).toBe('b=empty')
  })

  it('keeps nothing without a key, and forgets by prefix', () => {
    render(<Probe id={null} />)
    act(() => screen.getByRole('button').click())
    expect(remembered('probe:null')).toBeUndefined()
    remember('douyu:following:1', 'x')
    remember('douyu:inventory:1', 'y')
    remember('schedule:event', 'z')
    forget('douyu:')
    expect(remembered('douyu:following:1')).toBeUndefined()
    expect(remembered('schedule:event')).toBe('z')
  })
})
