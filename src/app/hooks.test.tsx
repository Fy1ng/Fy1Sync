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
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { usePublishedHeight } from './hooks'

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
