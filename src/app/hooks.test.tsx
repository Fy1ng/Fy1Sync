/**
 * Tests for `usePublishedHeight`.
 *
 * It is the one hook here whose contract is a side effect on an element nobody looks at
 * directly: a CSS custom property that other rules read. The bar's height is not a number the
 * stylesheet can know — it folds with the stage width and with the length of its own labels —
 * so the interesting cases are the ones where there is nothing worth publishing yet, and
 * `offsetHeight` is 0 in jsdom for everything, which is exactly that case.
 */

import { useRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useFullscreen, usePublishedHeight } from './hooks'

/**
 * jsdom lays nothing out, so `offsetHeight` is 0 everywhere. Defining it per element is how a
 * test gets to say "this one is 103px tall" without a layout engine.
 */
function setHeight(node: HTMLElement, height: number): void {
  Object.defineProperty(node, 'offsetHeight', { configurable: true, value: height })
}

/** Host with the property, source whose height goes into it — the stage/bar pair, minimally. */
function Harness({ height }: { height: number }): React.ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const source = useRef<HTMLDivElement | null>(null)
  usePublishedHeight(source, host, '--bar-clearance')
  return (
    <div data-testid="host" ref={host}>
      <div
        data-testid="source"
        ref={(node) => {
          // Has to populate `source` as well as fake the height — a callback ref *is* the ref,
          // so assigning it here is what the hook reads. Runs during commit, before effects.
          source.current = node
          if (node) setHeight(node, height)
        }}
      />
    </div>
  )
}

describe('usePublishedHeight', () => {
  it('publishes the source height onto the host', () => {
    const { getByTestId } = render(<Harness height={103} />)
    expect(getByTestId('host').style.getPropertyValue('--bar-clearance')).toBe('103px')
  })

  it('rounds a fractional height up', () => {
    // Down would leave a subpixel of the bar showing above whatever is clearing it.
    const { getByTestId } = render(<Harness height={66.4} />)
    expect(getByTestId('host').style.getPropertyValue('--bar-clearance')).toBe('67px')
  })

  it('publishes nothing while the source has no laid-out height', () => {
    // 0 means "not measured yet", not "needs no clearance". Publishing it would collapse the
    // clearance to nothing and put the preview thumbnail back under the bar; leaving the
    // property unset keeps the stylesheet's own fallback in charge.
    const { getByTestId } = render(<Harness height={0} />)
    expect(getByTestId('host').style.getPropertyValue('--bar-clearance')).toBe('')
  })

  it('removes the property on unmount', () => {
    const { getByTestId, unmount } = render(<Harness height={142} />)
    const host = getByTestId('host')
    expect(host.style.getPropertyValue('--bar-clearance')).toBe('142px')
    unmount()
    expect(host.style.getPropertyValue('--bar-clearance')).toBe('')
  })
})

function FullscreenHarness() {
  const target = useRef<HTMLDivElement | null>(null)
  const fullscreen = useFullscreen(target)
  return <div ref={target}><button type="button" onClick={fullscreen.toggle}>切换</button>
    {fullscreen.error && <p role="alert">{fullscreen.error}</p>}</div>
}

describe('fullscreen errors', () => {
  it('shows a rejected permission and clears the message on retry', async () => {
    const request = vi.spyOn(Element.prototype, 'requestFullscreen').mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    render(<FullscreenHarness />)
    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法切换全屏')
    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shows synchronous fullscreen failures without throwing from the click handler', () => {
    vi.spyOn(Element.prototype, 'requestFullscreen').mockImplementation(() => { throw new Error('unavailable') })
    render(<FullscreenHarness />)
    fireEvent.click(screen.getByRole('button', { name: '切换' }))
    expect(screen.getByRole('alert')).toHaveTextContent('无法切换全屏')
  })
})
