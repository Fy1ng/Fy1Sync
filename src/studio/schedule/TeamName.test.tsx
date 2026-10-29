/** A crest that failed to load is tried again once main gives it a new address. */
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TeamName } from './ScheduleSheet'

const team = (logo: string | null) => ({ name: 'Natus Vincere', short: 'NaVi', logo })

describe('TeamName', () => {
  it('keeps an empty slot after a failure, and tries a replaced crest again', () => {
    const { container, rerender } = render(<TeamName team={team('app://app/team-logo/a')} />)
    const first = container.querySelector('img.match-logo')!
    fireEvent.error(first)
    expect(container.querySelector('img.match-logo')).toBeNull()
    expect(container.querySelector('.match-logo.is-empty')).not.toBeNull()
    // The same address stays empty on a re-render.
    rerender(<TeamName team={team('app://app/team-logo/a')} />)
    expect(container.querySelector('img.match-logo')).toBeNull()
    // A new address (the crest replaced) is drawn again.
    rerender(<TeamName team={team('app://app/team-logo/b')} />)
    expect(container.querySelector('img.match-logo')?.getAttribute('src')).toBe('app://app/team-logo/b')
  })

  it('draws no placeholder text while the crest has not arrived', () => {
    const { container } = render(<TeamName team={team(null)} />)
    expect(container.querySelector('.match-logo.is-empty')?.textContent).toBe('')
  })
})
